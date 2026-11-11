/**
 * Inline Method (⌘⌥N on a call) without the language server.
 *
 * v1 covers the transformation that is provably correct from the syntax alone: a
 * same-file function whose body is exactly one `return <expression>`. The call
 * is replaced by that expression with the parameters substituted, so
 *
 *     def double(x):
 *         return x * 2
 *
 * turns `double(a + 1)` into `(a + 1) * 2`. With no statements before the
 * return there is no local variable to rename, no control flow and no early
 * `return` — the cases a wider implementation must get right, and refuses here.
 *
 * Refused, with a hint: statements before the return, several returns, `yield`,
 * `await`, a decorator, a call that unpacks its arguments, a declaration taking
 * `*args` / `**kwargs`, a parameter the call leaves to a default it cannot see
 * used, and a call inside its own declaration.
 */
import type { ChangeSet, EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { IdentifierOccurrence, SyntaxNode } from "@/bindings";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { call, commands } from "@/platform/ipc";
import { chainAt, indentOf, isWriteTarget, offsetsOf, posAt, spanOf, type Span } from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

/**
 * Contexts where the expression can stand unwrapped: the call fills the slot, so
 * nothing around it can re-associate. Anywhere else (a sum, a comparison, an
 * attribute) the expression is wrapped rather than risk a precedence change.
 */
const SAFE_PARENT =
  /^(expression_statement|return_statement|argument_list|parenthesized_expression|block|module|statement_list|keyword_argument|default_parameter|assignment)$/;

/** The function a call sits inside, from the call's ancestor chain. */
function enclosingFunctionOf(chain: SyntaxNode[]): SyntaxNode | null {
  return chain.find((n) => n.kind === "function_definition") ?? null;
}

/** Whether the replacement needs parentheses where the call sits. */
function needsParens(chain: SyntaxNode[], callIndex: number): boolean {
  const callNode = chain[callIndex];
  const parent = chain[callIndex + 1];
  if (!callNode || !parent) return true;
  if (!SAFE_PARENT.test(parent.kind)) return true;
  // In an assignment the call is safe only as the whole right-hand side.
  if (parent.kind === "assignment" && callNode.field !== "right") return true;
  return false;
}

/** A call to a same-file function, and the expression that replaces it. */
export interface InlineCallPlan {
  /** Offsets of the call, its parentheses included. */
  from: number;
  to: number;
  /** The expression the call becomes, parameters already substituted. */
  text: string;
  /** Whether the replacement must be parenthesised where the call sits. */
  wrap: boolean;
  /** The callee's name, for hints and tests. */
  callee: string;
  /**
   * The declarations the body makes before its `return`, re-indented and moved
   * to the caller. `null` when the body was a single expression.
   */
  prelude: Prelude | null;
}

/** Statements to insert before the statement that holds the call. */
export interface Prelude {
  /** Where they go: the start of the line holding the call. */
  at: number;
  /** One statement per line, already indented for the caller. */
  text: string;
  /** The body's locals, renamed where they would clash in the caller. */
  renamed: { from: string; to: string }[];
}

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
  doc: Text;
}

function refuse(view: EditorView, why: string): true {
  showHint(view, tx`Cannot perform refactoring: ${why}`);
  return true;
}

/** Index of the `=` that assigns, skipping `==`, `>=` and anything nested. */
export function topLevelEquals(slice: string): number {
  let depth = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0) {
      const prev = slice[i - 1];
      const next = slice[i + 1];
      if (next === "=" || prev === "=" || prev === "!" || prev === "<" || prev === ">" || prev === ":") continue;
      return i;
    }
  }
  return -1;
}

/** Split on commas that are not nested inside brackets. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A parameter as the signature spells it. */
export interface Param {
  name: string;
  /** The default's text, or `null` when the call must bind it. */
  default: string | null;
  /** `*args` / `**kwargs`: variable arity. */
  splat: boolean;
}

/** `b`, `b: int`, `b=2`, `b: int = 2` → the name and the default's text. */
export function parseParam(slice: string): Param {
  const text = slice.trim();
  if (text.startsWith("*")) {
    const name = text.replace(/^\*+/, "").split(/[=:]/)[0]!.trim();
    return { name, default: null, splat: true };
  }
  const eq = topLevelEquals(text);
  const head = eq < 0 ? text : text.slice(0, eq);
  const def = eq < 0 ? null : text.slice(eq + 1).trim();
  return { name: head.split(":")[0]!.trim(), default: def || null, splat: false };
}

/**
 * The parameters of a `def` line, or why the shape is out of scope.
 *
 * The parameter list is parsed from the signature text: the names and default
 * texts are all the inlining needs, and reading them costs no extra query.
 */
export function parametersOf(signature: string): Param[] | string {
  const open = signature.indexOf("(");
  if (open < 0) return "the declaration has no parameter list";
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i]!;
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return "the parameter list is not closed";
  const params = splitTopLevel(signature.slice(open + 1, close)).map(parseParam);
  if (params.some((x) => x.splat)) return "the declaration takes *args or **kwargs";
  if (params.some((x) => !/^[A-Za-z_]\w*$/.test(x.name))) return "a parameter name could not be read";
  return params;
}

/** An argument as the call spells it. */
export interface Arg {
  /** The parameter it binds: by position, or by its keyword label. */
  name: string | null;
  text: string;
}

/** `f(a, b=1)` → `[{a}, {b, "1"}]`, matched against `params`. */
export function argumentsOf(callText: string, params: Param[]): Arg[] | string {
  const open = callText.indexOf("(");
  const close = callText.lastIndexOf(")");
  if (open < 0 || close < 0) return "the call has no argument list";
  const pieces = splitTopLevel(callText.slice(open + 1, close));
  if (pieces.some((x) => x.startsWith("*"))) return "the call unpacks its arguments";

  const out: Arg[] = [];
  let positional = 0;
  for (const piece of pieces) {
    const eq = topLevelEquals(piece);
    if (eq >= 0) {
      out.push({ name: piece.slice(0, eq).trim(), text: piece.slice(eq + 1).trim() });
      continue;
    }
    const param = params[positional];
    if (!param) return "the call passes more arguments than the declaration takes";
    out.push({ name: param.name, text: piece });
    positional++;
  }
  return out;
}

/** Text that can stand as an operand without parentheses. */
export function isAtomText(text: string): boolean {
  const t = text.trim();
  return (
    /^[A-Za-z_][\w.]*$/.test(t) ||
    /^-?\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?$/.test(t) ||
    /^(["']).*\1$/s.test(t) ||
    /^[A-Za-z_][\w.]*\(.*\)$/s.test(t) ||
    /^\[.*\]$/s.test(t) ||
    /^\{.*\}$/s.test(t) ||
    /^\(.*\)$/s.test(t)
  );
}

/**
 * `line` without a trailing `#` comment.
 *
 * A `#` inside a string is not a comment, so the scan follows the quote state.
 * The result keeps the original length up to the code's end, which is what a
 * range query needs: asking for a range that includes the comment makes
 * `nodeAt` answer with the enclosing block instead of the statement.
 */
export function stripTrailingComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i).replace(/\s+$/, "");
  }
  return line;
}

/** What a body holds: the declarations before its `return`, and that expression. */
export interface BodyPlan {
  /** Statements before the return, in order, with their whole text (nested blocks included). */
  statements: Span[];
  /** The returned expression. */
  ret: Span;
  /** The body's own indentation, to re-indent the statements for the caller. */
  indent: string;
}

/**
 * The statements of a body, and the one `return` they end in.
 *
 * The scan asks the tree about each line that starts a statement rather than
 * grouping lines by indentation: a compound statement (`if`, `for`, `try`) is one
 * node with a whole extent, which is what makes a body with a branch movable at
 * all. A docstring is dropped; it does nothing where it lands.
 *
 * Only a body whose single `return` is the last statement is inlined here. More
 * than one `return` needs the caller's control flow rewritten, which is a
 * different transformation.
 */
async function bodyOf(p: Prepared, fn: SyntaxNode): Promise<BodyPlan | string> {
  const fnSpan = spanOf(p.doc, fn);
  const text = p.doc.sliceString(fnSpan.from, fnSpan.to);
  if (/^\s*@/m.test(text)) return "the declaration is decorated";
  if (/^\s*async\s+def\b/.test(text)) return "the declaration is a coroutine";

  const colon = text.indexOf(":");
  if (colon < 0) return "the declaration has no body";
  const bodyText = text.slice(colon + 1);
  if (/\byield\b/.test(bodyText)) return "the declaration is a generator";
  if (/\bawait\b/.test(bodyText)) return "the declaration is a coroutine";

  const bodyFrom = fnSpan.from + colon + 1;
  const bodyEnd = fnSpan.to;
  // Skip the newline that ends the signature, if the body starts on the next line.
  const afterColon = p.doc.sliceString(bodyFrom, bodyEnd);
  const lead = /^[ \t]*\n[ \t]*/.exec(afterColon)?.[0].length ?? /^[ \t]*/.exec(afterColon)?.[0].length ?? 0;
  const firstLine = p.doc.lineAt(bodyFrom + lead);
  const indent = /^[ \t]*/.exec(firstLine.text)![0];
  if (!indent && p.doc.lines > firstLine.number) return "the declaration is not indented";

  const statements: Span[] = [];
  let line = firstLine.number;
  const lastLine = p.doc.lineAt(bodyEnd).number;
  while (line <= lastLine) {
    const current = p.doc.line(line);
    // Past the end of the declaration: the body is done.
    if (current.from >= bodyEnd) break;
    const code = stripTrailingComment(current.text);
    const trimmed = code.trim();
    // Blank lines and comment-only lines start nothing.
    if (!trimmed || /^#/.test(current.text.trim())) {
      line++;
      continue;
    }
    const lineIndent = /^[ \t]*/.exec(code)![0];
    // A statement of the body starts at the body's indent; anything deeper belongs
    // to a statement already recorded.
    if (lineIndent !== indent) return "the declaration is not indented";
    const from = current.from + lineIndent.length;
    const node = await structure.nodeAt(p.ctx.doc, offsetsToRange(p.doc, from, current.to)).catch(() => null);
    if (!node) return "a statement of the declaration could not be read";
    const span = trimSpan(p.doc, spanOf(p.doc, node.node));
    if (span.to > bodyEnd) return "the declaration has a statement this scope cannot move";
    // A docstring is a bare string: dropped, not moved.
    if (/^("""|''')/.test(trimmed)) {
      line = p.doc.lineAt(span.to).number + 1;
      continue;
    }
    statements.push(span);
    line = p.doc.lineAt(span.to).number + 1;
  }
  if (!statements.length) return "the declaration returns nothing";

  // Exactly one `return`, and it is the last statement: nothing can return early.
  const found = await returnsIn(p, statements);
  if (typeof found === "string") return found;
  if (found.length !== 1) return "the declaration returns from more than one place";

  const last = statements[statements.length - 1]!;
  if (found[0]!.from < last.from) return "the declaration returns from more than one place";
  const lastText = stripTrailingComment(p.doc.sliceString(last.from, last.to));
  if (!/^return\b/.test(lastText)) return "the declaration ends without a return";

  const retText = lastText.slice("return".length);
  const retLead = retText.length - retText.replace(/^\s+/, "").length;
  if (!retText.trim()) return "the declaration returns nothing";
  const ret = { from: last.from + "return".length + retLead, to: last.to };
  return { statements: statements.slice(0, -1), ret, indent };
}

/** `span` without surrounding whitespace. */
function trimSpan(doc: Text, span: Span): Span {
  let { from, to } = span;
  while (from < to && /\s/.test(doc.sliceString(from, from + 1))) from++;
  while (to > from && /\s/.test(doc.sliceString(to - 1, to))) to--;
  return { from, to };
}

/** Every `return` inside the given statements, resolved through the tree. */
async function returnsIn(p: Prepared, statements: Span[]): Promise<Span[] | string> {
  const out: Span[] = [];
  for (const statement of statements) {
    const text = p.doc.sliceString(statement.from, statement.to);
    for (const m of text.matchAll(/\breturn\b/g)) {
      const at = statement.from + m.index!;
      const node = await structure
        .nodeAt(p.doc === p.doc ? p.ctx.doc : p.ctx.doc, offsetsToRange(p.doc, at, at + 6))
        .catch(() => null);
      if (!node || node.node.kind !== "return_statement") continue;
      out.push(trimSpan(p.doc, spanOf(p.doc, node.node)));
    }
  }
  return out;
}

/** The declaration of `name` in the open document, from the outline. */
async function declarationOf(p: Prepared, name: string): Promise<SyntaxNode | string> {
  const outline = await call(commands.docOutline(p.ctx.doc)).catch(() => []);
  const hit = outline.find((item) => item.name === name && item.kind === "function");
  if (!hit) return `'${name}' is not declared in this file`;
  const n = await structure.nodeAt(p.ctx.doc, hit.range).catch(() => null);
  if (!n) return "the declaration could not be read";
  return n.node;
}

/**
 * Everything that can make the inlining unsafe is checked before any edit.
 * Returns the reason instead of a plan when it cannot be done.
 */
/**
 * Whether the caret sits on a call to a plain function name. `refactor.inline`
 * uses it to choose between Inline Method and Inline Variable, which share one
 * action in IDEA.
 */
export async function isCallUnderCaret(view: EditorView): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  const sel = view.state.selection.main;
  const chain = await chainAt(ctx, offsetsToRange(view.state.doc, sel.from, sel.to)).catch(() => null);
  if (!chain) return false;
  const callNode = chain.find((n) => n.kind === "call");
  if (!callNode) return false;
  const span = spanOf(view.state.doc, callNode);
  const text = view.state.doc.sliceString(span.from, span.to);
  return /^[A-Za-z_]\w*\s*\(/.test(text);
}

export async function planInlineFunction(view: EditorView): Promise<InlineCallPlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Inline Method needs the language server for this language";
  await whenSynced(view);
  const doc = view.state.doc;
  const p: Prepared = { view, ctx, doc };

  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Inline Method needs the language server here";

  const sel = view.state.selection.main;
  const chain = await chainAt(p.ctx, offsetsToRange(doc, sel.from, sel.to)).catch(() => null);
  if (!chain) return "place the caret on a call";
  const callIndex = chain.findIndex((n) => n.kind === "call");
  const callNode = chain[callIndex];
  if (!callNode) return "place the caret on a call";
  // The callee is a child of the call, not an ancestor, so it is read from the
  // call's text: everything before the argument list's `(`.
  const callSpan = spanOf(doc, callNode);
  const callText = doc.sliceString(callSpan.from, callSpan.to);
  const paren = callText.indexOf("(");
  if (paren < 0) return "the call has no argument list";
  const name = callText.slice(0, paren).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return "the call is not to a plain function name";

  const fn = await declarationOf(p, name);
  if (typeof fn === "string") return fn;
  const fnSpan = spanOf(doc, fn);
  if (callSpan.from >= fnSpan.from && callSpan.to <= fnSpan.to) return "the call is inside its own declaration";

  const signature = doc.sliceString(fnSpan.from, fnSpan.to);
  const params = parametersOf(signature);
  if (typeof params === "string") return params;
  const args = argumentsOf(callText, params);
  if (typeof args === "string") return args;

  // Every parameter must be bound exactly once: by an argument, or by its own
  // default when the call leaves it out.
  const bound = new Map<string, string>();
  for (const arg of args) {
    if (!arg.name) return "the call's arguments could not be matched to the parameters";
    if (bound.has(arg.name)) return `the call passes '${arg.name}' twice`;
    if (!params.some((x) => x.name === arg.name)) return `the call passes an unknown keyword '${arg.name}'`;
    bound.set(arg.name, arg.text);
  }
  for (const param of params) {
    if (bound.has(param.name)) continue;
    if (param.default === null) return `the call does not pass '${param.name}' and it has no default`;
    bound.set(param.name, param.default);
  }

  const body = await bodyOf(p, fn);
  if (typeof body === "string") return body;

  // Which names to rewrite inside a body span, and to what.
  const substitutions = new Map<string, string>();
  for (const [paramName, argText] of bound) {
    substitutions.set(paramName, isAtomText(argText) ? argText : `(${argText})`);
  }

  // Collisions: a local the body declares would shadow a name the caller already
  // uses, so it is renamed in the moved statements. This is the part that must be
  // right — shadowing the caller's variable silently changes its value.
  const renamed: { from: string; to: string }[] = [];
  if (body.statements.length) {
    // At module level the caller is the module itself, which is a valid place to
    // put the declarations: there is no enclosing function then.
    const callerFn = enclosingFunctionOf(chain);
    const scope = callerFn ? spanOf(doc, callerFn) : { from: 0, to: doc.length };
    // The names the body binds, in one request: a local whose definition lies
    // inside the moved text is declared by it.
    const first = body.statements[0]!;
    const movedTo = body.ret.to;
    const inBody = await structure
      .localsInRange(ctx.doc, posAt(doc, first.from), posAt(doc, movedTo))
      .catch(() => null);
    const declared: string[] = [];
    for (const n of inBody?.names ?? []) {
      if (n.locals.status !== "local") continue;
      const def = offsetsOf(doc, n.locals.symbol.definition);
      if (def.from >= first.from && def.to <= movedTo) declared.push(n.name);
    }
    for (const name of declared) {
      const found = await structure.identifiers(ctx.doc, name).catch(() => []);
      const clashes = found.some((occ) => {
        const span = offsetsOf(doc, occ.range);
        // Inside the callee is the declaration itself; inside the caller is a clash.
        if (span.from >= fnSpan.from && span.to <= fnSpan.to) return false;
        return span.from >= scope.from && span.to <= scope.to;
      });
      if (!clashes) continue;
      // A fresh name that appears nowhere in the caller.
      let candidate = `${name}_1`;
      for (let n = 2; n < 100; n++) {
        const used = await structure.identifiers(ctx.doc, candidate).catch(() => []);
        const taken = used.some((occ) => {
          const span = offsetsOf(doc, occ.range);
          return span.from >= scope.from && span.to <= scope.to;
        });
        if (!taken) break;
        candidate = `${name}_${n}`;
      }
      renamed.push({ from: name, to: candidate });
      substitutions.set(name, candidate);
    }
  }

  // A parameter written inside the body cannot be substituted: the assignment
  // means something different from the argument. `isWriteTarget` answers from the
  // node's field, which a text scan gets wrong (`x == y` is not a write).
  for (const param of params) {
    const found = await structure.identifiers(ctx.doc, param.name).catch(() => []);
    for (const occ of found) {
      const span = offsetsOf(doc, occ.range);
      const inBody =
        (span.from >= body.ret.from && span.to <= body.ret.to) ||
        body.statements.some((st) => span.from >= st.from && span.to <= st.to);
      if (!inBody || occ.qualified) continue;
      if (await isWriteTarget(ctx, occ.range)) {
        return `the declaration assigns to its parameter '${param.name}'`;
      }
    }
  }

  /** The text of `span` with the substitutions applied. */
  const rewrite = async (span: Span): Promise<{ ok: true; text: string } | { ok: false; why: string }> => {
    const inner: { from: number; to: number; text: string }[] = [];
    for (const [from, to] of substitutions) {
      const found: IdentifierOccurrence[] = await structure.identifiers(ctx.doc, from).catch(() => []);
      for (const occ of found) {
        if (occ.qualified) continue;
        const s = offsetsOf(doc, occ.range);
        if (s.from < span.from || s.to > span.to) continue;
        inner.push({ from: s.from, to: s.to, text: to });
      }
    }
    inner.sort((a, b) => a.from - b.from);
    let out = "";
    let cursor = span.from;
    for (const edit of inner) {
      // Overlapping occurrences would mean the same name was matched twice.
      if (edit.from < cursor) return { ok: false, why: "a name occurrence could not be replaced" };
      out += doc.sliceString(cursor, edit.from) + edit.text;
      cursor = edit.to;
    }
    out += doc.sliceString(cursor, span.to);
    return { ok: true, text: out };
  };

  const retText = await rewrite(body.ret);
  if (!retText.ok) return retText.why;

  // With statements to move, the call must fill the whole right-hand side or be a
  // statement on its own: a multi-line body cannot go inside an expression.
  let prelude: Prelude | null = null;
  if (body.statements.length) {
    const parent = chain[callIndex + 1];
    const alone =
      (parent?.kind === "assignment" && chain[callIndex]!.field === "right") ||
      (parent?.kind === "expression_statement" && chain[callIndex]!.field === null) ||
      (parent?.kind === "return_statement" && chain[callIndex]!.field === null);
    if (!alone) return "the call is part of an expression and its declaration has statements";
    const stmtNode = parent!;
    const stmtSpan = spanOf(doc, stmtNode);
    const indent = indentOf(doc, stmtSpan.from);
    const out: string[] = [];
    for (const st of body.statements) {
      const stmtText = await rewrite(st);
      if (!stmtText.ok) return stmtText.why;
      // The body's own indentation is dropped, then the caller's is applied: the
      // two differ when the call sits at module level, or in deeper nesting.
      const lines = stmtText.text.split("\n").map((l, i) => {
        if (i === 0) return l;
        return body.indent && l.startsWith(body.indent) ? l.slice(body.indent.length) : l;
      });
      out.push([indent + lines[0], ...lines.slice(1).map((l) => indent + l)].join("\n"));
    }
    prelude = { at: doc.lineAt(stmtSpan.from).from, text: out.join("\n") + "\n", renamed };
  }

  // The call's surroundings decide whether the expression must be wrapped.
  const wrap = needsParens(chain, callIndex);
  return { from: callSpan.from, to: callSpan.to, text: retText.text, wrap, callee: name, prelude };
}

function changesFor(plan: InlineCallPlan, state: EditorState): ChangeSet {
  const edits = [{ from: plan.from, to: plan.to, insert: plan.wrap ? `(${plan.text})` : plan.text }];
  // The body's declarations go above the statement that held the call.
  if (plan.prelude) edits.push({ from: plan.prelude.at, to: plan.prelude.at, insert: plan.prelude.text });
  return state.changes(edits);
}

function apply(p: Prepared, plan: InlineCallPlan) {
  const { view } = p;
  if (view.state.doc !== p.doc) {
    showHint(view, tx`The document changed; invoke the refactoring again`);
    return;
  }
  const changes = changesFor(plan, view.state);
  view.dispatch({
    changes,
    selection: { anchor: changes.mapPos(plan.from, 1) },
    scrollIntoView: true,
    userEvent: "refactor.inline",
  });
  view.focus();
}

/**
 * Runs the refactoring. Returns whether the document changed, like
 * `inlineFallback`, so the caller can tell a refusal from a no-op.
 */
export async function inlineFunctionFallback(view: EditorView): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const planned = await planInlineFunction(view);
    if (typeof planned === "string") return refuse(view, planned);
    if (view.state.doc !== before) {
      showHint(view, tx`The document changed; invoke the refactoring again`);
      return true;
    }
    apply({ view, ctx, doc: view.state.doc }, planned);
    return view.state.doc !== before;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return view.state.doc !== before;
  }
}
