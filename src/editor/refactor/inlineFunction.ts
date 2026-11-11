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
import type { Range, SyntaxNode } from "@/bindings";
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
  /** The body's locals, renamed where they would clash in the caller. */
  renamed: { from: string; to: string }[];
}

/** Statements to insert before the statement that holds the call. */
export interface Prelude {
  /** Where they go: the start of the line holding the call. */
  at: number;
  /** One statement per line, already indented for the caller. */
  text: string;
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
/** The body of a same-file declaration, as the statements it is made of. */
interface Body {
  /** Top-level statements, in order, whitespace trimmed, docstrings dropped. */
  statements: Span[];
  /** The body's own indentation, to re-indent the statements for the caller. */
  indent: string;
  /** One level of nesting, as the declaration spaces it. */
  step: string;
}

/**
 * The `:` that ends a signature: the first one outside brackets.
 *
 * `def f(x: int) -> str:` has three colons and only the last one starts the body.
 * An annotation sits inside the parameter list, so bracket depth separates them.
 */
export function bodyColon(signature: string): number {
  let depth = 0;
  for (let i = 0; i < signature.length; i++) {
    const c = signature[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "#") {
      const end = signature.indexOf("\n", i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"' || c === "'") {
      // A default value or a return annotation may hold a colon in a string.
      const quote = signature.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const close = signature.indexOf(quote, i + quote.length);
      if (close < 0) return -1;
      i = close + quote.length - 1;
    } else if (c === ":" && depth === 0) return i;
  }
  return -1;
}

/**
 * The statements of a body, top level only.
 *
 * The scan asks the tree about each line that starts a statement rather than
 * grouping lines by indentation: a compound statement (`if`, `for`, `try`) is one
 * node with a whole extent, which is what makes a body with a branch movable at
 * all. A docstring is dropped; it does nothing where it lands.
 */
async function bodyOf(p: Prepared, fn: SyntaxNode): Promise<Body | string> {
  const fnSpan = spanOf(p.doc, fn);
  const text = p.doc.sliceString(fnSpan.from, fnSpan.to);
  if (/^\s*@/m.test(text)) return "the declaration is decorated";
  if (/^\s*async\s+def\b/.test(text)) return "the declaration is a coroutine";

  const colon = bodyColon(text);
  if (colon < 0) return "the declaration has no body";
  const bodyText = text.slice(colon + 1);
  if (/\byield\b/.test(bodyText)) return "the declaration is a generator";
  if (/\bawait\b/.test(bodyText)) return "the declaration is a coroutine";

  const bodyFrom = fnSpan.from + colon + 1;
  const bodyEnd = fnSpan.to;
  const fnIndent = indentOf(p.doc, fnSpan.from);
  // A body on the signature line has no indentation to carry over.
  const sameLine = stripTrailingComment(p.doc.sliceString(bodyFrom, p.doc.lineAt(bodyFrom).to)).trim();
  if (sameLine) return "the declaration has its body on the signature line";

  const lastLine = p.doc.lineAt(bodyEnd).number;
  let line = p.doc.lineAt(bodyFrom + 1).number;
  // Blank lines and comments may open the body; its indentation is the first
  // line that actually carries code.
  let indent = "";
  for (; line <= lastLine; line++) {
    const current = p.doc.line(line);
    if (!stripTrailingComment(current.text).trim()) continue;
    indent = /^[ \t]*/.exec(current.text)![0];
    break;
  }
  if (line > lastLine) return "the declaration returns nothing";
  if (indent.length <= fnIndent.length) return "the declaration is not indented";
  const step = indent.slice(fnIndent.length);

  const statements: Span[] = [];
  while (line <= lastLine) {
    const current = p.doc.line(line);
    // Past the end of the declaration: the body is done.
    if (current.from >= bodyEnd) break;
    const code = stripTrailingComment(current.text);
    if (!code.trim() || /^#/.test(current.text.trim())) {
      line++;
      continue;
    }
    const lineIndent = /^[ \t]*/.exec(code)![0];
    // A statement of the body starts at the body's indent. A shallower line ends
    // the body; a deeper one belongs to a statement already recorded.
    if (lineIndent.length < indent.length) break;
    if (lineIndent !== indent) {
      line++;
      continue;
    }
    const from = current.from + lineIndent.length;
    const node = await structure.nodeAt(p.ctx.doc, offsetsToRange(p.doc, from, current.to)).catch(() => null);
    if (!node) return "a statement of the declaration could not be read";
    const span = trimSpan(p.doc, spanOf(p.doc, node.node));
    if (span.to > bodyEnd) return "the declaration has a statement this scope cannot move";
    // A docstring is a bare string: dropped, not moved.
    if (/^("""|''')/.test(code.trim())) {
      line = p.doc.lineAt(span.to).number + 1;
      continue;
    }
    statements.push(span);
    line = p.doc.lineAt(span.to).number + 1;
  }
  if (!statements.length) return "the declaration returns nothing";
  return { statements, indent, step };
}

/** `span` without surrounding whitespace. */
function trimSpan(doc: Text, span: Span): Span {
  let { from, to } = span;
  while (from < to && /\s/.test(doc.sliceString(from, from + 1))) from++;
  while (to > from && /\s/.test(doc.sliceString(to - 1, to))) to--;
  return { from, to };
}

/** A `return` written by the declaration itself. */
interface ReturnSite {
  /** The whole `return …` statement. */
  stmt: Span;
  /** The returned expression, or `null` for a bare `return`. */
  value: Span | null;
  /** Whether a loop the body itself contains stands between it and the caller. */
  inLoop: boolean;
}

/** Loop nodes: a `break` inside one of them leaves that loop, not our wrapper. */
const LOOP_KIND = new Set(["for_statement", "while_statement"]);

/** Scopes nested inside the declaration. */
const NESTED_SCOPE = new Set(["function_definition", "class_definition", "lambda"]);

function sameNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.range.start.line === b.range.start.line && a.range.start.col === b.range.start.col;
}

/** Every `return` of the declaration itself, in the order they appear. */
async function returnsIn(p: Prepared, fn: SyntaxNode, body: Body): Promise<ReturnSite[] | string> {
  const out: ReturnSite[] = [];
  for (const statement of body.statements) {
    const text = p.doc.sliceString(statement.from, statement.to);
    for (const m of text.matchAll(/\breturn\b/g)) {
      const at = statement.from + m.index!;
      const found = await structure
        .nodeAt(p.ctx.doc, offsetsToRange(p.doc, at, at + "return".length))
        .catch(() => null);
      if (!found || found.node.kind !== "return_statement") continue;
      // A nested declaration's returns are its own, not this body's.
      let owner = false;
      let inLoop = false;
      for (const ancestor of found.ancestors) {
        if (ancestor.kind === "function_definition") {
          owner = sameNode(ancestor, fn);
          break;
        }
        if (LOOP_KIND.has(ancestor.kind)) inLoop = true;
      }
      if (!owner) continue;
      const stmt = trimSpan(p.doc, spanOf(p.doc, found.node));
      const stmtText = stripTrailingComment(p.doc.sliceString(stmt.from, stmt.to));
      const keyword = /^return\b/.exec(stmtText);
      if (!keyword) continue;
      const rest = stmtText.slice(keyword[0].length);
      const lead = rest.length - rest.replace(/^\s+/, "").length;
      const value = rest.trim()
        ? { from: stmt.from + keyword[0].length + lead, to: stmt.from + stmtText.length }
        : null;
      out.push({ stmt, value, inLoop });
    }
  }
  return out;
}

/** Whether `range` sits inside a `def`, a `class` or a `lambda` nested in `fn`. */
async function insideNestedScope(p: Prepared, range: Range, fn: SyntaxNode): Promise<boolean> {
  const found = await structure.nodeAt(p.ctx.doc, range).catch(() => null);
  if (!found) return false;
  for (const ancestor of found.ancestors) {
    if (sameNode(ancestor, fn)) return false;
    if (NESTED_SCOPE.has(ancestor.kind)) return true;
  }
  return false;
}

/** `span`'s text with `edits` applied, or `null` when two of them overlap. */
function applyEdits(doc: Text, span: Span, edits: { from: number; to: number; insert: string }[]): string | null {
  const inner = edits
    .filter((e) => e.from >= span.from && e.to <= span.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  let out = "";
  let cursor = span.from;
  for (const edit of inner) {
    // Overlapping occurrences would mean the same text was replaced twice.
    if (edit.from < cursor) return null;
    out += doc.sliceString(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return out + doc.sliceString(cursor, span.to);
}

/** Re-indent a copied block from the declaration's indentation to the caller's. */
function reindent(text: string, from: string, to: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      return to + (from && line.startsWith(from) ? line.slice(from.length) : line);
    })
    .join("\n");
}

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

  const returns = await returnsIn(p, fn, body);
  if (typeof returns === "string") return returns;
  if (!returns.length) return "the declaration returns nothing";

  const first = body.statements[0]!;
  const last = body.statements[body.statements.length - 1]!;
  // Everything the move carries: from the first statement's line to the end of
  // the last one. Blank lines and comments in between travel with it.
  const region: Span = { from: doc.lineAt(first.from).from, to: last.to };

  // Which names to rewrite inside the moved text, and to what.
  const substitutions = new Map<string, string>();
  for (const [paramName, argText] of bound) {
    substitutions.set(paramName, isAtomText(argText) ? argText : `(${argText})`);
  }

  // Collisions: a local the body declares would shadow a name the caller already
  // uses, so it is renamed in the moved statements. This is the part that must be
  // right — shadowing the caller's variable silently changes its value.
  const renamed: { from: string; to: string }[] = [];
  {
    // At module level the caller is the module itself, which is a valid place to
    // put the declarations: there is no enclosing function then.
    const callerFn = enclosingFunctionOf(chain);
    const scope = callerFn ? spanOf(doc, callerFn) : { from: 0, to: doc.length };
    // The names the body binds, in one request: a local whose definition lies
    // inside the moved text is declared by it.
    const inBody = await structure
      .localsInRange(ctx.doc, posAt(doc, region.from), posAt(doc, region.to))
      .catch(() => null);
    const declared: string[] = [];
    for (const n of inBody?.names ?? []) {
      if (n.locals.status !== "local") continue;
      const def = offsetsOf(doc, n.locals.symbol.definition);
      if (def.from >= region.from && def.to <= region.to) declared.push(n.name);
    }
    for (const local of declared) {
      const found = await structure.identifiers(ctx.doc, local).catch(() => []);
      const clashes = found.some((occ) => {
        const span = offsetsOf(doc, occ.range);
        // Inside the callee is the declaration itself; inside the caller is a clash.
        if (span.from >= fnSpan.from && span.to <= fnSpan.to) return false;
        return span.from >= scope.from && span.to <= scope.to;
      });
      if (!clashes) continue;
      // A fresh name that appears nowhere in the caller.
      let candidate = `${local}_1`;
      for (let n = 2; n < 100; n++) {
        const used = await structure.identifiers(ctx.doc, candidate).catch(() => []);
        const taken = used.some((occ) => {
          const span = offsetsOf(doc, occ.range);
          return span.from >= scope.from && span.to <= scope.to;
        });
        if (!taken) break;
        candidate = `${local}_${n}`;
      }
      renamed.push({ from: local, to: candidate });
      substitutions.set(local, candidate);
    }
  }

  // A substitution only holds where the name still means the callee's parameter or
  // local: never on a write, and not inside a scope of the body's own that rebinds
  // it, where the same text names something else.
  const movedText = doc.sliceString(region.from, region.to);
  const nests = /\b(def|class|lambda)\b/.test(movedText);
  const subEdits: { from: number; to: number; insert: string }[] = [];
  for (const [from, to] of substitutions) {
    const found = await structure.identifiers(ctx.doc, from).catch(() => []);
    for (const occ of found) {
      if (occ.qualified) continue;
      const s = offsetsOf(doc, occ.range);
      if (s.from < region.from || s.to > region.to) continue;
      if (nests && (await insideNestedScope(p, occ.range, fn))) {
        return `'${from}' is rebound by a scope of the declaration's own`;
      }
      if (bound.has(from) && (await isWriteTarget(ctx, occ.range))) {
        return `the declaration assigns to its parameter '${from}'`;
      }
      subEdits.push({ from: s.from, to: s.to, insert: to });
    }
  }

  // One `return`, last, with an expression: the call becomes that expression and
  // the rest of the body is a prelude. Anything else moves the body itself.
  const trailing =
    returns.length === 1 &&
    returns[0]!.value !== null &&
    returns[0]!.stmt.from === last.from &&
    returns[0]!.stmt.to === last.to;

  if (trailing) {
    const value = applyEdits(doc, returns[0]!.value!, subEdits);
    if (value === null) return "a name occurrence could not be replaced";
    const preamble = body.statements.slice(0, -1);
    let prelude: Prelude | null = null;
    if (preamble.length) {
      // A multi-line body cannot go inside an expression: the call must fill the
      // whole right-hand side or be a statement on its own.
      const parent = chain[callIndex + 1];
      const alone =
        (parent?.kind === "assignment" && chain[callIndex]!.field === "right") ||
        (parent?.kind === "expression_statement" && chain[callIndex]!.field === null) ||
        (parent?.kind === "return_statement" && chain[callIndex]!.field === null);
      if (!alone) return "the call is part of an expression and its declaration has statements";
      const stmtSpan = spanOf(doc, parent!);
      const indent = indentOf(doc, stmtSpan.from);
      const carried = applyEdits(
        doc,
        { from: doc.lineAt(first.from).from, to: preamble[preamble.length - 1]!.to },
        subEdits,
      );
      if (carried === null) return "a name occurrence could not be replaced";
      prelude = {
        at: doc.lineAt(stmtSpan.from).from,
        text: reindent(carried, body.indent, indent) + "\n",
      };
    }
    const wrap = needsParens(chain, callIndex);
    return { from: callSpan.from, to: callSpan.to, text: value, wrap, callee: name, prelude, renamed };
  }

  return planMovesBody({ p, chain, callIndex, callText, name, fn, body, returns, region, subEdits, renamed });
}

/** What a body with early returns can be inlined into: the caller's statement. */
const NOT_A_STATEMENT = "the declaration returns more than once and the call is part of a larger expression";

/**
 * Copy the body into the caller, so that every `return` it has becomes a value
 * plus a way out.
 *
 * A `while True:` around the copy gives the leaving a target: `return x` becomes
 * `answer = x` and `break`, which runs the caller's remaining statements as
 * skipping them once would not. That rewrite needs the `break` to belong to the
 * wrapper, so a return nested in one of the body's own loops is refused, and it
 * needs a name to assign to, so the call must be the whole right-hand side of
 * `name = call`. A `return call` needs neither: the body's returns already return
 * from the caller's function, so it is copied as it stands.
 */
async function planMovesBody(args: {
  p: Prepared;
  chain: SyntaxNode[];
  callIndex: number;
  callText: string;
  name: string;
  fn: SyntaxNode;
  body: Body;
  returns: ReturnSite[];
  region: Span;
  subEdits: { from: number; to: number; insert: string }[];
  renamed: { from: string; to: string }[];
}): Promise<InlineCallPlan | string> {
  const { p, chain, callIndex, callText, name, fn, body, returns, region, subEdits, renamed } = args;
  const doc = p.doc;
  const parent = chain[callIndex + 1];
  if (!parent) return NOT_A_STATEMENT;
  const field = chain[callIndex]!.field;
  // A statement node starts at its keyword; a hand-built one may carry the indent.
  const stmtSpan = trimSpan(doc, spanOf(doc, parent));
  const stmtLine = doc.lineAt(stmtSpan.from);
  const indent = indentOf(doc, stmtSpan.from);
  // The statement must own its lines: a wrapper cannot be spliced into a line
  // that already holds other code.
  if (stmtSpan.from !== stmtLine.from + indent.length) return NOT_A_STATEMENT;
  const endLine = doc.lineAt(stmtSpan.to);
  const rest = doc.sliceString(stmtSpan.to, endLine.to).trim();
  const comment = rest.startsWith("#") ? rest : "";
  if (rest && !comment) return NOT_A_STATEMENT;
  const stmtText = stripTrailingComment(doc.sliceString(stmtSpan.from, stmtSpan.to));

  let shape: "assign" | "discard" | "return";
  let target = "";
  if (parent.kind === "assignment" && field === "right") {
    const eq = topLevelEquals(stmtText);
    if (eq < 0) return NOT_A_STATEMENT;
    if (stmtText.slice(eq + 1).trim() !== callText) return NOT_A_STATEMENT;
    target = stmtText.slice(0, eq).trim();
    if (!/^[A-Za-z_]\w*$/.test(target)) {
      return "the declaration returns from more than one place and the call's result is not assigned to a name";
    }
    shape = "assign";
  } else if (parent.kind === "expression_statement" && field === null) {
    if (stmtText.trim() !== callText) return NOT_A_STATEMENT;
    shape = "discard";
  } else if (parent.kind === "return_statement" && field === null) {
    if (stmtText.trim().replace(/^return\s*/, "") !== callText) return NOT_A_STATEMENT;
    shape = "return";
  } else {
    return NOT_A_STATEMENT;
  }

  const siteEdits: { from: number; to: number; insert: string }[] = [];
  if (shape !== "return") {
    // `break` leaves the nearest loop, so a return cannot be rewritten where the
    // body keeps one of its own loops between it and the caller.
    if (returns.some((r) => r.inLoop)) return "the declaration returns from inside a loop";
    for (const site of returns) {
      // `return x` must start its line, or the `break` it grows has no home.
      if (site.stmt.from !== doc.lineAt(site.stmt.from).from + indentOf(doc, site.stmt.from).length) {
        return "the declaration writes a return beside other code";
      }
      const value = site.value ? applyEdits(doc, site.value, subEdits) : null;
      if (site.value && value === null) return "a name occurrence could not be replaced";
      const siteIndent = indentOf(doc, site.stmt.from);
      siteEdits.push({
        from: site.stmt.from,
        to: site.stmt.to,
        // A bare `return` leaves the value at None; a discarded result needs no name.
        insert: shape === "assign" ? `${target} = ${value ?? "None"}\n${siteIndent}break` : "break",
      });
    }
  }

  const sites = returns.map((r) => r.stmt);
  const carried = applyEdits(doc, region, [
    // The site rewrite already covers the substitutions inside it.
    ...subEdits.filter((e) => !sites.some((s) => e.from >= s.from && e.to <= s.to)),
    ...siteEdits,
  ]);
  if (carried === null) return "a name occurrence could not be replaced";

  const replace: Span = { from: stmtLine.from, to: endLine.to };
  const callee = name;
  if (shape === "return") {
    const text = reindent(carried, body.indent, indent);
    return {
      from: replace.from,
      to: replace.to,
      text: comment ? `${text}  ${comment}` : text,
      wrap: false,
      callee,
      prelude: null,
      renamed,
    };
  }

  const inner = indent + body.step;
  const lines = [indent + "while True:" + (comment ? `  ${comment}` : ""), reindent(carried, body.indent, inner)];
  // A body that can run off its end leaves the caller's variable at None, exactly
  // as falling off the declaration's end returned None.
  const endsInReturn = returns.some((r) => r.stmt.from === body.statements[body.statements.length - 1]!.from);
  if (!endsInReturn) {
    if (shape === "assign") lines.push(`${inner}${target} = None`);
    lines.push(`${inner}break`);
  }
  void fn;
  return { from: replace.from, to: replace.to, text: lines.join("\n"), wrap: false, callee, prelude: null, renamed };
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
