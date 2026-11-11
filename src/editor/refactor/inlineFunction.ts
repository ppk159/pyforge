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
/**
 * What a parameter is, which decides where the call's values go.
 *
 * `*name` collects the extra positional arguments into a tuple, `**name` collects
 * the unmatched keywords into a dict, and a bare `*` is not a parameter at all —
 * it only marks the ones after it as keyword-only.
 */
export type ParamKind = "positional" | "varargs" | "kwargs";

export interface Param {
  name: string;
  /** The default's text, or `null` when the call must bind it. */
  default: string | null;
  kind: ParamKind;
  /** After `*` / `*args`: a positional argument cannot bind it. */
  keywordOnly: boolean;
  /** The bare `*` itself, which names nothing. */
  separator?: boolean;
}

/** `b`, `b: int`, `b=2`, `b: int = 2`, `*rest`, `**kw`, `*` → the parameter. */
export function parseParam(slice: string): Param {
  const text = slice.trim();
  if (text.startsWith("**")) {
    const name = text.slice(2).split(/[=:]/)[0]!.trim();
    return { name, default: null, kind: "kwargs", keywordOnly: true };
  }
  if (text.startsWith("*")) {
    const name = text.slice(1).split(/[=:]/)[0]!.trim();
    // A bare `*` names nothing; it only starts the keyword-only section.
    if (!name) return { name: "", default: null, kind: "positional", keywordOnly: true, separator: true };
    return { name, default: null, kind: "varargs", keywordOnly: true };
  }
  const eq = topLevelEquals(text);
  const head = eq < 0 ? text : text.slice(0, eq);
  const def = eq < 0 ? null : text.slice(eq + 1).trim();
  return { name: head.split(":")[0]!.trim(), default: def || null, kind: "positional", keywordOnly: false };
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
  // Everything after a `*` or `*name` is keyword-only, whatever it looks like.
  let keywordSection = false;
  for (const param of params) {
    if (param.separator || param.kind === "varargs") keywordSection = true;
    else if (param.kind === "positional") param.keywordOnly = keywordSection;
  }
  if (params.some((x) => !x.separator && !/^[A-Za-z_]\w*$/.test(x.name))) {
    return "a parameter name could not be read";
  }
  return params;
}

/** A call's arguments, as the call spells them. */
export interface CallArgs {
  /** Positional arguments, in order, before any keyword. */
  positional: string[];
  /** `name=value` arguments, in order. */
  keyword: { name: string; value: string }[];
  /** `f(*xs)` / `f(**d)`: the argument list is not known until it runs. */
  spread: string | null;
}

export function argumentsOf(callText: string): CallArgs | string {
  const open = callText.indexOf("(");
  const close = callText.lastIndexOf(")");
  if (open < 0 || close < 0) return "the call has no argument list";
  const out: CallArgs = { positional: [], keyword: [], spread: null };
  let sawKeyword = false;
  for (const piece of splitTopLevel(callText.slice(open + 1, close))) {
    if (piece.startsWith("**") || piece.startsWith("*")) {
      out.spread = piece;
      continue;
    }
    const eq = topLevelEquals(piece);
    if (eq >= 0) {
      out.keyword.push({ name: piece.slice(0, eq).trim(), value: piece.slice(eq + 1).trim() });
      sawKeyword = true;
      continue;
    }
    // Python allows no positional argument after a keyword one.
    if (sawKeyword) return "the call's arguments could not be matched to the parameters";
    out.positional.push(piece);
  }
  return out;
}

/**
 * One parameter and the value it starts with in the caller.
 *
 * `asLocal` marks a parameter that must *stay* a variable: `*args` and `**kwargs`
 * hold a collection the call built, not one expression, so there is nothing to
 * substitute for them.
 */
export interface Binding {
  name: string;
  text: string;
  asLocal: boolean;
}

/** A tuple literal for `items`, with the trailing comma a single value needs. */
export function tupleLiteral(items: string[]): string {
  if (!items.length) return "()";
  const parts = items.map((t) => (isAtomText(t) ? t : `(${t})`));
  return parts.length === 1 ? `(${parts[0]},)` : `(${parts.join(", ")})`;
}

/**
 * Which parameter each argument fills, or why the call does not line up.
 *
 * The rules are Python's own: positional arguments fill the positional parameters
 * in order, a `*name` takes the leftovers as a tuple, keywords fill by name or
 * join `**name`, and a parameter the call leaves out falls back to its default.
 */
export function bindArguments(params: Param[], args: CallArgs): Binding[] | string {
  if (args.spread !== null) return "the call unpacks its arguments";
  const real = params.filter((x) => !x.separator);
  const byPosition = real.filter((p) => p.kind === "positional" && !p.keywordOnly);
  const varargs = real.find((p) => p.kind === "varargs") ?? null;
  const kwargs = real.find((p) => p.kind === "kwargs") ?? null;

  const bound = new Map<string, Binding>();
  let i = 0;
  for (; i < args.positional.length && i < byPosition.length; i++) {
    const param = byPosition[i]!;
    bound.set(param.name, { name: param.name, text: args.positional[i]!, asLocal: false });
  }
  const extra = args.positional.slice(i);
  if (extra.length && !varargs) return "the call passes more arguments than the declaration takes";

  const intoKwargs: { name: string; value: string }[] = [];
  for (const kw of args.keyword) {
    const named = real.find((p) => p.kind === "positional" && p.name === kw.name);
    if (named) {
      if (bound.has(named.name)) return `the call passes '${kw.name}' twice`;
      bound.set(named.name, { name: named.name, text: kw.value, asLocal: false });
      continue;
    }
    if (kwargs) {
      intoKwargs.push(kw);
      continue;
    }
    return `the call passes an unknown keyword '${kw.name}'`;
  }

  for (const param of real) {
    if (param.kind !== "positional" || bound.has(param.name)) continue;
    if (param.default === null) return `the call does not pass '${param.name}' and it has no default`;
    bound.set(param.name, { name: param.name, text: param.default, asLocal: false });
  }

  if (varargs) {
    bound.set(varargs.name, { name: varargs.name, text: tupleLiteral(extra), asLocal: true });
  }
  if (kwargs) {
    const entries = intoKwargs.map((kw) => `${JSON.stringify(kw.name)}: ${kw.value}`);
    bound.set(kwargs.name, {
      name: kwargs.name,
      text: entries.length ? `{${entries.join(", ")}}` : "{}",
      asLocal: true,
    });
  }
  return [...bound.values()];
}

/** Whether `text` is a string literal, which may clash with an f-string's quotes. */
export function isStringLiteral(text: string): boolean {
  return /^[rRbBuUfF]{0,2}(["'])/.test(text.trim());
}

/**
 * The quote of the f-string `range` sits inside, or `null` when it sits in no
 * replacement field.
 *
 * A value substituted into `{…}` lands inside the surrounding string, so it has to
 * survive that string's quotes. A triple-quoted f-string tolerates a single quote
 * of the same kind; a single-quoted one does not.
 */
async function fstringQuoteAt(p: Prepared, range: Range): Promise<string | null> {
  const found = await structure.nodeAt(p.ctx.doc, range).catch(() => null);
  if (!found) return null;
  const chain = [found.node, ...found.ancestors];
  const field = chain.findIndex((n) => n.kind === "interpolation");
  if (field < 0) return null;
  const string = chain[field + 1];
  if (!string || string.kind !== "string") return null;
  const span = spanOf(p.doc, string);
  const head = p.doc.sliceString(span.from, Math.min(span.to, span.from + 6));
  const quote = /^[rRbBuUfF]{0,2}("""|'''|"|')/.exec(head);
  if (!quote) return null;
  // Only an f-string has replacement fields; a plain string here is a nested quote.
  if (!/f/i.test(quote[0])) return null;
  return quote[1]!;
}

/**
 * `text` quoted so it can sit inside an f-string that uses `quote`.
 *
 * `null` when it cannot be done: both quote characters are in use, or the body
 * ends with a backslash that would escape the closing quote.
 */
export function requote(text: string, quote: string): string | null {
  const t = text.trim();
  const m = /^([rRbBuUfF]{0,2})(["'])([\s\S]*)\2$/.exec(t);
  if (!m) return null;
  const [, prefix, used, body] = m as unknown as [string, string, string, string];
  // A triple-quoted f-string can hold either single quote unchanged.
  if (quote.length === 3) return t;
  if (used !== quote) return t;
  const other = used === '"' ? "'" : '"';
  if (body.includes(other) || body.endsWith("\\")) return null;
  return `${prefix}${other}${body}${other}`;
}

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
  const args = argumentsOf(callText);
  if (typeof args === "string") return args;

  // Which parameter each argument fills. `*args` / `**kwargs` come back marked
  // `asLocal`: their value is a tuple or dict the call built, so they stay
  // variables in the caller instead of being substituted.
  const bindings = bindArguments(params, args);
  if (typeof bindings === "string") return bindings;

  const body = await bodyOf(p, fn);
  if (typeof body === "string") return body;

  const returns = await returnsIn(p, fn, body);
  if (typeof returns === "string") return returns;

  const first = body.statements[0]!;
  const last = body.statements[body.statements.length - 1]!;
  // Everything the move carries: from the first statement's line to the end of
  // the last one. Blank lines and comments in between travel with it.
  const region: Span = { from: doc.lineAt(first.from).from, to: last.to };

  // Which names to rewrite inside the moved text, and to what. A `*args` /
  // `**kwargs` parameter is skipped here: its value is a tuple or dict the call
  // built, so it stays a variable and is set up with the other init lines.
  const substitutions = new Map<string, string>();
  for (const b of bindings) {
    if (b.asLocal) continue;
    substitutions.set(b.name, isAtomText(b.text) ? b.text : `(${b.text})`);
  }

  // Collisions: a local the body declares would shadow a name the caller already
  // uses, so it is renamed in the moved statements. This is the part that must be
  // right — shadowing the caller's variable silently changes its value.
  const renamed: { from: string; to: string }[] = [];
  // At module level the caller is the module itself, which is a valid place to put
  // the declarations: there is no enclosing function then.
  const callerFn = enclosingFunctionOf(chain);
  const scope = callerFn ? spanOf(doc, callerFn) : { from: 0, to: doc.length };
  {
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
      const fresh = await freshName(p, local, scope, fnSpan);
      if (fresh === local) continue;
      renamed.push({ from: local, to: fresh });
      substitutions.set(local, fresh);
    }
  }

  // The parameters that must become variables of the caller, with the value each
  // starts as. Two reasons to be here: the body writes the parameter, so
  // substituting the argument would reach through to the caller's own variable;
  // or it is `*args` / `**kwargs`, whose value the call built out of the
  // arguments and which no single expression stands for.
  const initLines: string[] = [];
  for (const b of bindings) {
    let local: string;
    if (b.asLocal) {
      local = await freshName(p, b.name, scope, fnSpan);
    } else {
      const found = await structure.identifiers(ctx.doc, b.name).catch(() => []);
      let written = false;
      for (const occ of found) {
        if (occ.qualified) continue;
        const s = offsetsOf(doc, occ.range);
        if (s.from < region.from || s.to > region.to) continue;
        if (await isWriteTarget(ctx, occ.range)) {
          written = true;
          break;
        }
      }
      if (!written) continue;
      local = await freshName(p, b.name, scope, fnSpan);
    }
    if (local !== b.name) renamed.push({ from: b.name, to: local });
    substitutions.set(b.name, local);
    initLines.push(`${local} = ${b.text}`);
  }

  // A substitution only holds where the name still means the callee's parameter or
  // local: never inside a scope of the body's own that rebinds it, where the same
  // text names something else.
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
      // A value that lands inside an f-string's `{…}` has to survive that
      // string's quotes: `f"{"n"}"` is a syntax error before Python 3.12.
      let insert = to;
      if (isStringLiteral(to)) {
        const quote = await fstringQuoteAt(p, occ.range);
        if (quote) {
          const fixed = requote(insert, quote);
          if (fixed === null) return `'${from}' is substituted inside an f-string that cannot hold the value`;
          insert = fixed;
        }
      }
      subEdits.push({ from: s.from, to: s.to, insert });
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
    let text = value;
    if (preamble.length || initLines.length) {
      // The body is more than one line, so it cannot go where the call is. It goes
      // above the statement — unless the call is only part of that statement, in
      // which case a temporary holds the value and the call's place keeps the
      // temporary.
      const parent = chain[callIndex + 1];
      const alone =
        (parent?.kind === "assignment" && chain[callIndex]!.field === "right") ||
        (parent?.kind === "expression_statement" && chain[callIndex]!.field === null) ||
        (parent?.kind === "return_statement" && chain[callIndex]!.field === null);
      const stmtIndex = chain.findIndex((n, i) => i > callIndex && STATEMENT_KIND.has(n.kind));
      if (stmtIndex < 0) return "the call is not inside a statement";
      const stmtSpan = trimSpan(doc, spanOf(doc, chain[stmtIndex]!));
      const stmtLine = doc.lineAt(stmtSpan.from);
      const indent = indentOf(doc, stmtSpan.from);
      if (stmtSpan.from !== stmtLine.from + indent.length) {
        return "the call's statement shares its line with other code";
      }
      const lines = initLines.map((l) => indent + l);
      if (preamble.length) {
        const carried = applyEdits(
          doc,
          { from: doc.lineAt(first.from).from, to: preamble[preamble.length - 1]!.to },
          subEdits,
        );
        if (carried === null) return "a name occurrence could not be replaced";
        lines.push(reindent(carried, body.indent, indent));
      }
      if (!alone) {
        text = await freshName(p, `${name}_result`, scope, fnSpan);
        renamed.push({ from: `${name}_result`, to: text });
        lines.push(`${indent}${text} = ${value}`);
      }
      prelude = { at: stmtLine.from, text: lines.join("\n") + "\n" };
    }
    const wrap = needsParens(chain, callIndex);
    return { from: callSpan.from, to: callSpan.to, text, wrap, callee: name, prelude, renamed };
  }

  return planMovesBody({
    p,
    chain,
    callIndex,
    callSpan,
    callText,
    name,
    fn,
    body,
    returns,
    region,
    subEdits,
    renamed,
    initLines,
    scope,
  });
}

/** Node kinds that stand on their own: the call's body goes above one of these. */
const STATEMENT_KIND = new Set([
  "expression_statement",
  "return_statement",
  "assignment",
  "augmented_assignment",
  "if_statement",
  "for_statement",
  "while_statement",
  "with_statement",
  "try_statement",
  "raise_statement",
  "assert_statement",
  "delete_statement",
  "import_statement",
  "import_from_statement",
  "pass_statement",
  "break_statement",
  "continue_statement",
]);

/** What the call's result has to become once the body is copied out. */
type Shape =
  /** `x = f(a)` — the caller's own name takes the value. */
  | "assign"
  /** `self.x = f(a)` — a dotted or subscripted target takes it. */
  | "target"
  /** `f(a)` alone — the value is thrown away. */
  | "discard"
  /** `return f(a)` — the body's returns already return from here. */
  | "return"
  /** A temporary takes the value, and the call's place is left holding it. */
  | "temp";

/** `left` is writable as an assignment target: a name, `a.b` or `a[b]`. */
function isAssignable(left: string): boolean {
  const text = left.trim();
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(text)) return true;
  // A subscript, provided it is one expression and not a tuple target.
  return /^[A-Za-z_][\w.]*\[[\s\S]*\]$/.test(text) && splitTopLevel(text.slice(text.indexOf("["), -1)).length === 1;
}

/**
 * A name the caller's scope does not use, based on `wanted`.
 *
 * A local the body declares, or a parameter it writes, keeps its own name only
 * when the caller has no use for it: reusing one would silently change the
 * caller's variable.
 */
async function freshName(p: Prepared, wanted: string, scope: Span, ignore?: Span): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => {
    const found = await structure.identifiers(p.ctx.doc, candidate).catch(() => []);
    return found.some((occ) => {
      const span = offsetsOf(p.doc, occ.range);
      // Inside the callee is the declaration itself, not a use in the caller.
      if (ignore && span.from >= ignore.from && span.to <= ignore.to) return false;
      return span.from >= scope.from && span.to <= scope.to;
    });
  };
  if (!(await taken(wanted))) return wanted;
  for (let n = 1; n < 100; n++) {
    const candidate = `${wanted}_${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${wanted}_x`;
}

/**
 * Copy the body into the caller, so that every `return` it has becomes a value
 * plus a way out.
 *
 * A `while True:` around the copy gives the leaving a target: `return x` becomes
 * `answer = x` and `break`, which runs the caller's remaining statements as
 * skipping them once would not. That rewrite needs the `break` to belong to the
 * wrapper, so a return nested in one of the body's own loops is refused.
 *
 * Where the answer goes depends on the call's position. `x = f(a)` puts it in the
 * caller's own name; `self.x = f(a)` assigns to that target; `return f(a)` needs
 * no rewrite at all, because the body's returns return from the caller's function
 * already. A call that is only part of the statement (`y = f(a) + 1`) gets a
 * temporary, and the call's place is left holding that temporary.
 */
async function planMovesBody(args: {
  p: Prepared;
  chain: SyntaxNode[];
  callIndex: number;
  callSpan: Span;
  callText: string;
  name: string;
  fn: SyntaxNode;
  body: Body;
  returns: ReturnSite[];
  region: Span;
  subEdits: { from: number; to: number; insert: string }[];
  renamed: { from: string; to: string }[];
  /** Locals the body's parameters start as, in order, already substituted. */
  initLines: string[];
  scope: Span;
}): Promise<InlineCallPlan | string> {
  const { p, chain, callIndex, callSpan, callText, name, fn, body, returns, region, subEdits, renamed } = args;
  const { initLines, scope } = args;
  const doc = p.doc;

  // The statement the call belongs to, outermost first: the body goes above it.
  const stmtIndex = chain.findIndex((n, i) => i > callIndex && STATEMENT_KIND.has(n.kind));
  if (stmtIndex < 0) return "the call is not inside a statement";
  const stmtSpan = trimSpan(doc, spanOf(doc, chain[stmtIndex]!));
  const stmtLine = doc.lineAt(stmtSpan.from);
  const indent = indentOf(doc, stmtSpan.from);
  // The statement must start its line: the body is inserted there, and putting it
  // above other code on the same line would run it in the wrong order.
  if (stmtSpan.from !== stmtLine.from + indent.length) {
    return "the call's statement shares its line with other code";
  }
  const endLine = doc.lineAt(stmtSpan.to);
  const rest = doc.sliceString(stmtSpan.to, endLine.to).trim();
  const comment = rest.startsWith("#") ? rest : "";
  const stmtText = stripTrailingComment(doc.sliceString(stmtSpan.from, stmtSpan.to));

  // The call's immediate surroundings decide whether the statement can take the
  // value directly, or needs a temporary to stand in for it.
  const parent = chain[callIndex + 1];
  const field = chain[callIndex]!.field;
  const whole = (text: string, keyword = "") => {
    let body = text.trim();
    if (keyword) {
      if (!body.startsWith(keyword)) return false;
      body = body.slice(keyword.length).trim();
    }
    return body === callText.trim();
  };

  let shape: Shape;
  let target = "";
  if (parent?.kind === "assignment" && field === "right" && whole(stmtText.slice(topLevelEquals(stmtText) + 1))) {
    const eq = topLevelEquals(stmtText);
    const left = stmtText.slice(0, eq).trim();
    if (!isAssignable(left)) return "the call's result is assigned to a target this scope cannot write";
    target = left;
    shape = /^[A-Za-z_]\w*$/.test(left) ? "assign" : "target";
  } else if (parent?.kind === "expression_statement" && field === null && whole(stmtText)) {
    shape = "discard";
  } else if (parent?.kind === "return_statement" && field === null && whole(stmtText, "return")) {
    shape = "return";
  } else {
    // The call is part of a larger expression: a temporary holds its result.
    target = await freshName(p, `${name}_result`, scope);
    renamed.push({ from: `${name}_result`, to: target });
    shape = "temp";
  }

  const writes = shape !== "return" && shape !== "discard";
  const siteEdits: { from: number; to: number; insert: string }[] = [];
  if (writes) {
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
      // A bare `return` leaves the value at None.
      siteEdits.push({
        from: site.stmt.from,
        to: site.stmt.to,
        insert: `${target} = ${value ?? "None"}\n${siteIndent}break`,
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

  /** The body's statements at `at`, as the caller indents them. */
  const copied = (at: string): string[] => [reindent(carried, body.indent, at)];

  // A body with no `return` at all needs no control flow: the call ran those
  // statements and answered None, so they are copied and the answer is spelled
  // out where the call used to be.
  if (!returns.length) {
    const lines = [...initLines.map((l) => indent + l), ...copied(indent)];
    if (shape === "assign" || shape === "target" || shape === "temp") lines.push(`${indent}${target} = None`);
    else if (shape === "return") lines.push(`${indent}return None`);
    if (comment) lines[lines.length - 1] += `  ${comment}`;
    void fn;
    return shape === "temp"
      ? {
          from: callSpan.from,
          to: callSpan.to,
          text: target,
          wrap: false,
          callee: name,
          prelude: { at: stmtLine.from, text: lines.join("\n") + "\n" },
          renamed,
        }
      : {
          from: stmtLine.from,
          to: endLine.to,
          text: lines.join("\n"),
          wrap: false,
          callee: name,
          prelude: null,
          renamed,
        };
  }

  if (shape === "return") {
    const text = [...initLines.map((l) => indent + l), ...copied(indent)].join("\n");
    return {
      from: stmtLine.from,
      to: endLine.to,
      text: comment ? `${text}  ${comment}` : text,
      wrap: false,
      callee: name,
      prelude: null,
      renamed,
    };
  }

  const inner = indent + body.step;
  const lines = [
    ...initLines.map((l) => indent + l),
    indent + "while True:" + (comment ? `  ${comment}` : ""),
    ...copied(inner),
  ];
  // A body that can run off its end leaves the target at None, exactly as falling
  // off the declaration's end returned None.
  const endsInReturn = returns.some((r) => r.stmt.from === body.statements[body.statements.length - 1]!.from);
  if (!endsInReturn) {
    if (shape !== "discard") lines.push(`${inner}${target} = None`);
    lines.push(`${inner}break`);
  }
  void fn;
  return shape === "temp"
    ? {
        from: callSpan.from,
        to: callSpan.to,
        text: target,
        wrap: false,
        callee: name,
        prelude: { at: stmtLine.from, text: lines.join("\n") + "\n" },
        renamed,
      }
    : {
        from: stmtLine.from,
        to: endLine.to,
        text: lines.join("\n"),
        wrap: false,
        callee: name,
        prelude: null,
        renamed,
      };
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
