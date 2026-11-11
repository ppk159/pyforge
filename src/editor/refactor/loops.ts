/**
 * Loop ↔ Comprehension, without the language server.
 *
 * The two directions are not equally provable, and the difference drives
 * everything here.
 *
 * A comprehension says exactly what it builds and how many times the expression
 * runs: `[f(x) for x in items if p(x)]` cannot append twice for one item, cannot
 * `break`, and cannot write anything but the target. Rewriting it as a loop is
 * mechanical — the loop appends once per surviving item, which is what the
 * comprehension already did.
 *
 * A loop says much less. Rewriting it as a comprehension is sound only when the
 * body is nothing but that one append, wrapped in `if` tests: `break`, a second
 * statement, an `else` clause, or a write to another name would all change what
 * the comprehension does. And the loop's variable stops existing after the
 * conversion, because a comprehension has a scope of its own — so a loop variable
 * read after the loop makes the conversion wrong.
 */
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { chainAt, indentOf, offsetsOf, spanOf } from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
  doc: Text;
}

function refuse(view: EditorView, why: string): true {
  showHint(view, tx`Cannot perform refactoring: ${why}`);
  return true;
}

/** What the replacement is, and the span it replaces. */
export interface ConversionPlan {
  from: number;
  to: number;
  text: string;
}

/** Index of `word` at bracket depth zero, or `-1`. */
export function topLevelKeyword(text: string, word: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === word[0] && text.startsWith(word, i)) {
      const after = text[i + word.length] ?? " ";
      if (/[\s(]/.test(after)) return i;
    }
  }
  return -1;
}

/** Where the next `for` / `if` clause starts, or the end of the header. */
export function nextClauseAt(text: string): number {
  const at = ["for", "if"]
    .map((w) => topLevelKeyword(text, w))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return at ?? text.length;
}

/** One `for` clause of a comprehension, with the `if` tests that follow it. */
export interface Clause {
  target: string;
  iterable: string;
  conditions: string[];
}

/**
 * The clauses of a comprehension, from its header text.
 *
 * `for a in b if c for d in e` nests left to right: each `for` opens a level and
 * the `if`s after it test that level. Cutting the text at bracket depth zero keeps
 * a nested comprehension's own clauses with the iterable they belong to.
 */
export function clausesOf(header: string): Clause[] | string {
  const clauses: Clause[] = [];
  let rest = header.trim();
  while (rest) {
    const forAt = topLevelKeyword(rest, "for");
    if (forAt !== 0) return "the comprehension's clauses could not be read";
    rest = rest.slice(3).trim();
    const inAt = topLevelKeyword(rest, "in");
    if (inAt < 0) return "the comprehension's clauses could not be read";
    const target = rest.slice(0, inAt).trim();
    rest = rest.slice(inAt + 2).trim();
    const stop = nextClauseAt(rest);
    const iterable = rest.slice(0, stop).trim();
    rest = rest.slice(stop).trim();
    const conditions: string[] = [];
    while (topLevelKeyword(rest, "if") === 0) {
      rest = rest.slice(2).trim();
      const until = nextClauseAt(rest);
      conditions.push(rest.slice(0, until).trim());
      rest = rest.slice(until).trim();
    }
    if (!target || !iterable) return "the comprehension's clauses could not be read";
    clauses.push({ target, iterable, conditions });
  }
  return clauses.length ? clauses : "the comprehension's clauses could not be read";
}

/** Split `{k: v for …}`'s value at the colon that separates key from value. */
function dictEntry(value: string): { key: string; value: string } | string {
  const at = topLevelKeyword(value, ":");
  if (at < 0) return "the dictionary entry could not be read";
  return { key: value.slice(0, at).trim(), value: value.slice(at + 1).trim() };
}

/** How one comprehension kind is created and extended, keyed by node kind. */
const COLLECTOR: Record<string, { init: string; add: string }> = {
  list_comprehension: { init: "[]", add: "append" },
  set_comprehension: { init: "set()", add: "add" },
  dictionary_comprehension: { init: "{}", add: "item" },
};

/** The indentation one level means here: what the file already uses. */
export function indentUnit(doc: Text, indent: string): string {
  if (indent.includes("\t")) return "\t";
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (!text.trim()) continue;
    const lead = /^[ \t]*/.exec(text)![0];
    if (lead.length > indent.length) return lead.slice(indent.length);
  }
  return "    ";
}

// ---------------------------------------------------------------------------
// Comprehension → loop
// ---------------------------------------------------------------------------

/**
 * `squares = [f(x) for x in items if p(x)]` → a loop that appends.
 *
 * The result is assigned, because a loop needs a name to extend: a bare
 * comprehension's value can be anonymous, and there is nowhere to put it.
 */
export async function planComprehensionToLoop(view: EditorView): Promise<ConversionPlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Loop ↔ Comprehension needs the language server for this language";
  await whenSynced(view);
  const doc = view.state.doc;
  const p: Prepared = { view, ctx, doc };
  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Loop ↔ Comprehension needs the language server here";

  const sel = view.state.selection.main;
  const chain = await chainAt(p.ctx, offsetsToRange(doc, sel.from, sel.to)).catch(() => null);
  const at = chain?.findIndex((n) => COLLECTOR[n.kind]) ?? -1;
  if (!chain || at < 0) return "place the caret on a list, set or dict comprehension";
  const node = chain[at]!;
  const kind = node.kind;

  const span = spanOf(doc, node);
  const text = doc.sliceString(span.from, span.to);
  const open = text[0]!;
  const close = text[text.length - 1]!;
  // A generator expression is delimited by `(` too, but the node kinds above only
  // match the three comprehension kinds, so the bracket pair is `[`/`{` here.
  if ((open !== "[" && open !== "{") || (close !== "]" && close !== "}")) {
    return "the comprehension is not bracketed";
  }
  const body = text.slice(1, -1);
  const forAt = topLevelKeyword(body, "for");
  if (forAt < 0) return "the comprehension's clauses could not be read";
  const value = body.slice(0, forAt).trim();
  const clauses = clausesOf(body.slice(forAt));
  if (typeof clauses === "string") return clauses;

  const collector = COLLECTOR[kind]!;
  // A list and a set take one value; a dict takes a key and a value.
  let add: string;
  if (collector.add === "item") {
    const entry = dictEntry(value);
    if (typeof entry === "string") return entry;
    add = `[${entry.key}] = ${entry.value}`;
  } else {
    add = `.${collector.add}(${value})`;
  }

  // A loop extends a name. The comprehension must be the whole right-hand side of
  // `target = …`, and the target must be a plain name: a subscript would be
  // re-evaluated once per item, which the comprehension did not do.
  const parent = chain[at + 1];
  if (!parent || parent.kind !== "assignment") return "assign the comprehension to a name first";
  const assignSpan = spanOf(doc, parent);
  const assignText = doc.sliceString(assignSpan.from, assignSpan.to);
  const eq = assignText.indexOf("=");
  if (eq < 0) return "assign the comprehension to a name first";
  const target = assignText.slice(0, eq).trim();
  if (!/^[A-Za-z_]\w*$/.test(target)) return "assign the comprehension to a plain name first";
  if (assignText.slice(eq + 1).trim() !== text) return "assign the comprehension to a name first";

  const stmtLine = doc.lineAt(assignSpan.from);
  const indent = indentOf(doc, assignSpan.from);
  const unit = indentUnit(doc, indent);
  const lines = [`${indent}${target} = ${collector.init}`];
  let depth = 0;
  for (const clause of clauses) {
    lines.push(`${indent}${unit.repeat(depth)}for ${clause.target} in ${clause.iterable}:`);
    depth++;
    for (const condition of clause.conditions) {
      lines.push(`${indent}${unit.repeat(depth)}if ${condition}:`);
      depth++;
    }
  }
  lines.push(`${indent}${unit.repeat(depth)}${target}${add}`);
  void refuse;
  return { from: stmtLine.from, to: doc.lineAt(assignSpan.to).to, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Loop → comprehension
// ---------------------------------------------------------------------------

/** The empty collection a loop fills: `name = []`, `name = set()`, `name = {}`. */
const EMPTY = /^([A-Za-z_]\w*)\s*=\s*(\[\]|set\(\)|\{\}|dict\(\))$/;

const KIND_OF: Record<string, string> = { "[]": "list", "set()": "set", "{}": "dictionary", "dict()": "dictionary" };

/**
 * ```python
 * squares = []
 * for x in items:
 *     if keep(x):
 *         squares.append(f(x))
 * ```
 * → `squares = [f(x) for x in items if keep(x)]`
 *
 * The loop must sit directly under the empty collection, its body must be one
 * append wrapped in `if` tests, and nothing may read the loop variable afterwards.
 */
export async function planLoopToComprehension(view: EditorView): Promise<ConversionPlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Loop ↔ Comprehension needs the language server for this language";
  await whenSynced(view);
  const doc = view.state.doc;
  const p: Prepared = { view, ctx, doc };
  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Loop ↔ Comprehension needs the language server here";

  const sel = view.state.selection.main;
  const chain = await chainAt(p.ctx, offsetsToRange(doc, sel.from, sel.to)).catch(() => null);
  const loop = chain?.find((n) => n.kind === "for_statement");
  if (!loop) return "place the caret on a for loop";
  const loopSpan = spanOf(doc, loop);
  const loopText = doc.sliceString(loopSpan.from, loopSpan.to);

  // A comprehension has no `else` clause, cannot leave early, and yields nothing.
  if (/^\s*else\s*:/m.test(loopText)) return "the loop has an else clause";
  for (const word of ["break", "continue", "return", "yield", "await"]) {
    if (new RegExp(`\\b${word}\\b`).test(loopText)) return `the loop contains '${word}'`;
  }

  const header = /^[ \t]*for\s+([\s\S]*?)\s+in\s+([\s\S]*?)\s*:[ \t]*(?:#[^\n]*)?$/m.exec(loopText);
  if (!header) return "the loop's header could not be read";
  const loopTarget = header[1]!.trim();
  if (!/^[A-Za-z_]\w*$/.test(loopTarget)) return "the loop's target is not a plain name";
  const iterable = header[2]!.trim();

  const loopIndent = indentOf(doc, loopSpan.from);
  const unit = indentUnit(doc, loopIndent);

  // The body, one statement per line, at the indentations the loop uses. Only `if`
  // lines may precede the append, and the append must be last.
  const bodyLines: { text: string; depth: number }[] = [];
  const firstBodyLine = doc.lineAt(loopSpan.from).number + 1;
  const lastLine = doc.lineAt(loopSpan.to).number;
  for (let n = firstBodyLine; n <= lastLine; n++) {
    const line = doc.line(n);
    if (!line.text.trim() || line.text.trim().startsWith("#")) continue;
    const lead = /^[ \t]*/.exec(line.text)![0];
    if (lead.length <= loopIndent.length) continue;
    if (!lead.startsWith(loopIndent + unit)) return "the loop's body is indented inconsistently";
    const depth = (lead.length - loopIndent.length) / unit.length;
    if (!Number.isInteger(depth)) return "the loop's body is indented inconsistently";
    bodyLines.push({ text: line.text.trim().replace(/\s+#.*$/, ""), depth });
  }
  if (!bodyLines.length) return "the loop's body is not a single append";

  const conditions: string[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    const wantDepth = i + 1;
    if (line.depth !== wantDepth) return "the loop's body is not a single append";
    if (i === bodyLines.length - 1) break;
    if (!/^if\b/.test(line.text)) return "the loop's body is not a single append";
    conditions.push(line.text.slice(2).replace(/:\s*$/, "").trim());
  }
  const last = bodyLines[bodyLines.length - 1]!;
  // Two shapes fill a collection: `out.append(v)` / `out.add(v)` for a list or a
  // set, and `out[k] = v` for a dict.
  const call = /^([A-Za-z_]\w*)\.(append|add)\s*\(([\s\S]*)\)$/.exec(last.text);
  const item = /^([A-Za-z_]\w*)\s*\[([\s\S]*)\]\s*=\s*([\s\S]*)$/.exec(last.text);
  let name: string;
  let method: string;
  let value: string;
  if (call) {
    name = call[1]!;
    method = call[2]!;
    value = call[3]!.trim();
  } else if (item) {
    name = item[1]!;
    method = "item";
    value = `${item[2]!.trim()}: ${item[3]!.trim()}`;
  } else {
    return "the loop's body is not a single append";
  }
  if (!value) return "the loop's body is not a single append";

  // The loop variable does not exist after conversion: a comprehension binds it in
  // a scope of its own, so a read afterwards would stop resolving.
  const uses = await structure.identifiers(ctx.doc, loopTarget).catch(() => []);
  if (uses.some((occ) => offsetsOf(doc, occ.range).from > loopSpan.to)) {
    return `the loop variable '${loopTarget}' is read after the loop`;
  }

  // The collection must be empty right above the loop: a comprehension builds the
  // whole thing in one expression, so nothing may have been added before.
  const aboveNumber = doc.lineAt(loopSpan.from).number - 1;
  if (aboveNumber < 1) return "the loop does not follow an empty collection";
  const above = doc.line(aboveNumber);
  const init = EMPTY.exec(above.text.trim());
  if (!init) return "the loop does not follow an empty collection";
  const initName = init[1]!;
  const kind = KIND_OF[init[2]!]!;
  if (initName !== name) return "the loop appends to a different collection than it builds";
  const wantMethod = kind === "set" ? "add" : kind === "dictionary" ? "item" : "append";
  if (method !== wantMethod) return "the loop appends to a different collection than it builds";
  if (kind === "dictionary") {
    const entry = dictEntry(value);
    if (typeof entry === "string") return "the loop's append is not a dictionary entry";
  }
  // The loop must be the statement right after the init, at the same indentation.
  if (indentOf(doc, above.from) !== loopIndent) return "the loop does not follow an empty collection";

  const opener = kind === "list" ? `[` : `{`;
  const closer = kind === "list" ? "]" : "}";
  const tests = conditions.length ? " if " + conditions.join(" if ") : "";
  const comprehension = `${loopIndent}${initName} = ${opener}${value} for ${loopTarget} in ${iterable}${tests}${closer}`;
  return { from: above.from, to: doc.lineAt(loopSpan.to).to, text: comprehension };
}

/**
 * Runs a planned conversion. Returns whether the document changed, like the other
 * refactorings, so a caller can tell a refusal from a no-op.
 */
export async function runConversion(
  view: EditorView,
  plan: (view: EditorView) => Promise<ConversionPlan | string>,
): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const planned = await plan(view);
    if (typeof planned === "string") return refuse(view, planned);
    if (view.state.doc !== before) {
      showHint(view, tx`The document changed; invoke the refactoring again`);
      return true;
    }
    view.dispatch({
      changes: { from: planned.from, to: planned.to, insert: planned.text },
      selection: { anchor: planned.from },
      scrollIntoView: true,
      userEvent: "refactor.convert",
    });
    view.focus();
    return view.state.doc !== before;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return view.state.doc !== before;
  }
}

export const comprehensionToLoop = (view: EditorView) => runConversion(view, planComprehensionToLoop);
export const loopToComprehension = (view: EditorView) => runConversion(view, planLoopToComprehension);
