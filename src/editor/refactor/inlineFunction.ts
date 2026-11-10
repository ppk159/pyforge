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
import { chainAt, offsetsOf, spanOf, type Span } from "./analysis";
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
 * The expression of a body that is exactly one `return <expr>`, as offsets, or
 * why the body is not that shape.
 */
async function singleReturn(p: Prepared, fn: SyntaxNode): Promise<Span | string> {
  const fnSpan = spanOf(p.doc, fn);
  const text = p.doc.sliceString(fnSpan.from, fnSpan.to);
  if (/^\s*@/m.test(text) || /^\s*@/.test(text)) return "the declaration is decorated";
  if (/^\s*async\s+def\b/.test(text)) return "the declaration is a coroutine";

  const colon = text.indexOf(":");
  if (colon < 0) return "the declaration has no body";
  const body = text.slice(colon + 1);
  if (/\byield\b/.test(body)) return "the declaration is a generator";
  if (/\bawait\b/.test(body)) return "the declaration is a coroutine";

  const at = body.search(/\breturn\b/);
  if (at < 0) return "the declaration returns nothing";
  const before = body.slice(0, at);
  const after = body.slice(at + "return".length);
  // Statements before the return would have to be inlined too.
  if (
    before
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, "")
      .replace(/#[^\n]*/g, "")
      .trim()
  ) {
    return "the declaration does more than return an expression";
  }
  if (/\breturn\b/.test(after)) return "the declaration returns from more than one place";

  const exprText = after.trim();
  if (!exprText) return "the declaration returns nothing";
  const lead = after.length - after.replace(/^\s+/, "").length;
  const from = fnSpan.from + colon + 1 + at + "return".length + lead;
  return { from, to: from + exprText.length };
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

  const expr = await singleReturn(p, fn);
  if (typeof expr === "string") return expr;

  // Substitute each parameter's occurrences. `identifiers` already skips
  // attribute names, keyword labels, comments and strings, so only real
  // references to the parameter are replaced.
  const edits: { from: number; to: number; text: string }[] = [];
  for (const [paramName, argText] of bound) {
    const found: IdentifierOccurrence[] = await structure.identifiers(ctx.doc, paramName).catch(() => []);
    for (const occ of found) {
      if (occ.qualified) continue;
      const span = offsetsOf(doc, occ.range);
      if (span.from < expr.from || span.to > expr.to) continue;
      edits.push({ from: span.from, to: span.to, text: isAtomText(argText) ? argText : `(${argText})` });
    }
  }
  edits.sort((a, b) => a.from - b.from);

  let out = "";
  let cursor = expr.from;
  for (const edit of edits) {
    // Overlapping occurrences would mean the parameter was matched twice.
    if (edit.from < cursor) return "a parameter occurrence could not be replaced";
    out += doc.sliceString(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  out += doc.sliceString(cursor, expr.to);

  // The call's surroundings decide whether the expression must be wrapped.
  const wrap = needsParens(chain, callIndex);
  return { from: callSpan.from, to: callSpan.to, text: out, wrap, callee: name };
}

function changesFor(plan: InlineCallPlan, state: EditorState): ChangeSet {
  return state.changes([{ from: plan.from, to: plan.to, insert: plan.wrap ? `(${plan.text})` : plan.text }]);
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
