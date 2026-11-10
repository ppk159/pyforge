/**
 * Extract Method without the language server, from the tree-sitter structure
 * service (IDEA's "dumb mode"). Called by the LSP actions only when the server
 * is not usable, or answered nothing over code with syntax errors.
 *
 * Scope of the syntax-only implementation (wider cases need the server):
 *  - Python, and only whole statements of one function body;
 *  - free variables become parameters, one value written for the caller
 *    becomes the return value;
 *  - anything the syntax cannot decide is refused with a hint, never guessed.
 *
 * Same model as `introduce.ts`: plan first (pure), then a single `dispatch`
 * with one `ChangeSet`, so the whole refactoring is one undo step; a rename
 * re-runs the plan instead of patching the applied text.
 */
import type { ChangeSet, EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { isIdentifier, isKeyword, nameStyle, uniqueNames } from "./names";
import {
  firstContent,
  indentOf,
  isBlankLine as blank,
  isWriteTarget as isWritten,
  offsetsOf as offsets,
  signatureBinds,
  posAt,
  spanOf,
  statementAt,
  withinRange as within,
  type StatementAt,
} from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

/** Statements/expressions that leave the enclosing function. */
const LEAVING = /\b(return|yield|await)\b/;
/** Declarations that make a name belong to a scope other than its block. */
const REBOUND = /\b(global|nonlocal)\b/;
/**
 * Patterns the bundled Python scope query does not cover (measured with
 * `probe_dataflow.rs`): `match`/`case` bindings, and a starred assignment
 * target (`first, *rest = pair`) — `rest` comes back `Unresolved`, so it would
 * be skipped and the value silently lost.
 */
const MATCH = /^\s*(match|case)\s+.+:\s*(#.*)?$/m;

/**
 * A line whose left of `=` embeds `*name`: a starred assignment target. Read
 * as text because the scope query does not report one and the node API exposes
 * no children. `f(*args)` is not one: nothing precedes its `=`.
 */
function starredTarget(text: string): string | null {
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const m = /\*\s*([A-Za-z_]\w*)/.exec(line.slice(0, eq));
    if (m) return m[1]!;
  }
  return null;
}

export interface ExtractPlan {
  /** The whole statements the call replaces (document offsets). */
  from: number;
  to: number;
  /** Selected statement text, original coordinates. */
  body: string;
  /** Indent shared by the selected statements (stripped from the body). */
  bodyIndent: string;
  /** Indent of the new `def`, and of its body. */
  defIndent: string;
  bodyIndentInner: string;
  /** Where the new `def` goes: right after the enclosing function's last line. */
  insertAt: number;
  /** Free variables, first use first. */
  params: string[];
  /** The one value written for the caller, if any. */
  output: string | null;
}

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
  doc: Text;
}

function cap(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Grows the selection to whole lines and checks the result is one run of
 * statements: every non-blank line is at least as deep as the first, the last
 * one is not the head of a block, and both ends are whole lines (a half
 * selected line would split a statement).
 */
export function wholeStatements(
  doc: Text,
  selFrom: number,
  selTo: number,
): { from: number; to: number; indent: string } | string {
  const head = doc.lineAt(selFrom);
  const tail = doc.lineAt(Math.min(Math.max(selTo - 1, selFrom), doc.length));
  if (doc.sliceString(head.from, selFrom).trim()) return "the selection must start at a statement boundary";
  if (doc.sliceString(selTo, tail.to).trim()) return "the selection must end at a statement boundary";
  const from = head.from;
  const to = tail.to;
  const lines = doc.sliceString(from, to).split("\n");
  const first = lines.find((l) => !blank(l));
  if (!first) return "the selection has no statements";
  const indent = /^[ \t]*/.exec(first)![0];
  if (!indent) return "the selection must be inside a function body";
  for (const line of lines) {
    if (blank(line) || line.startsWith(indent)) continue;
    return "the selection is not one run of statements at the same level";
  }
  const last = [...lines].reverse().find((l) => !blank(l))!;
  if (last.trimEnd().endsWith(":")) return "the selection ends with the head of a block";
  const text = doc.sliceString(from, to);
  if (LEAVING.test(text)) return "the selection contains return, yield or await";
  if (REBOUND.test(text)) return "the selection declares a global or nonlocal name";
  if (MATCH.test(text)) return "the selection contains a match statement, which the syntax service does not resolve";
  const starred = starredTarget(text);
  if (starred) {
    return `the selection uses a starred assignment target ('*${starred}'), which the syntax service does not resolve`;
  }
  return { from, to, indent };
}

/**
 * `self` and `cls` are in the shared keyword list (they are keywords in Rust and
 * Ruby) but are ordinary implicit parameters in Python: skipping them would drop
 * a free variable from the extracted signature.
 */
const IMPLICIT_PARAMS = new Set(["self", "cls"]);

interface Flow {
  params: string[];
  output: string | null;
}

/**
 * Which identifiers the selected statements read from outside the selection
 * and which one they write for the caller. One `locals` answer per distinct
 * name: `LocalSymbol.references` already lists every occurrence of it, so the
 * cost stays around one request per name.
 *
 * Every occurrence of a name is tried, cheapest first: the first one may sit in
 * a member position (`tags=` in `f(tags=tags)`) where `locals` answers about
 * the label rather than the variable.
 */
async function analyze(p: Prepared, from: number, to: number, ownerText: string): Promise<Flow | string> {
  // One request for the whole selection: the service walks the tree once and
  // answers every name it finds, instead of one round trip per name.
  const range = await structure.localsInRange(p.ctx.doc, posAt(p.doc, from), posAt(p.doc, to)).catch(() => null);
  if (!range) return "the syntax service could not read the selection";
  if (range.truncated) return "the selection mentions too many different names";

  const params: { name: string; at: number }[] = [];
  const written: string[] = [];
  for (const { name, at, locals } of range.names) {
    // `self` and `cls` are keywords in the shared list but implicit parameters here.
    if (isKeyword(name) && !IMPLICIT_PARAMS.has(name)) continue;
    if (locals.status === "noIdentifier") continue;
    if (locals.status === "notLocal") {
      // A member name (`self.locale_time`) is not a variable. Anything else is a
      // module-level name (which stays in scope, so passing it would be wrong), a
      // builtin, or a local the scope query missed (which must be refused, or the
      // generated method reads an undefined name).
      if (locals.reason !== "member" && signatureBinds(ownerText, name)) {
        return `'${name}' is local to this function but the syntax service cannot resolve it here`;
      }
      continue;
    }
    const symbol = locals.symbol;
    if (!symbol.certain) return `'${name}' is declared more than once here`;
    const inside = within(offsets(p.doc, symbol.definition), from, to);
    const refs = symbol.references.map((r) => offsets(p.doc, r));
    const refsInside = refs.filter((r) => within(r, from, to));
    const refsOutside = refs.filter((r) => !within(r, from, to));
    if (inside) {
      // Declared in the selection: the caller only needs it if it outlives the call.
      if (refsOutside.length && !written.includes(name)) written.push(name);
      continue;
    }
    if (!refsInside.length) continue;
    // Declared outside and read here: the extracted method must receive it.
    for (const r of refsInside) {
      if (await isWritten(p.ctx, offsetsToRange(p.doc, r.from, r.to))) {
        return `the selection assigns '${name}', which is declared outside it`;
      }
    }
    // Order by the name's first occurrence, which the service reports.
    params.push({ name, at: at.line * 100_000 + at.col });
  }
  params.sort((a, b) => a.at - b.at);
  if (written.length > 1) {
    return `the selection assigns ${written.length} variables that are used afterwards (${written.join(", ")})`;
  }
  return { params: params.map((x) => x.name), output: written[0] ?? null };
}

/**
 * The statement list the selection belongs to and the statement it starts in.
 * The shared `statementAt` answers that; `null` becomes this refactoring's
 * refusal text.
 */
async function locateBlock(p: Prepared, sel: { from: number; to: number }): Promise<StatementAt | string> {
  const found = await statementAt(p.ctx, p.doc, firstContent(p.doc, sel.from, sel.to));
  return found ?? "select statements inside a function";
}

/**
 * Everything that can make the refactoring unsafe is checked before any edit.
 * Returns the reason instead of a plan when it cannot be done.
 */
export async function planExtract(view: EditorView): Promise<ExtractPlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Extract Method needs the language server for this language";
  const sel = view.state.selection.main;
  if (sel.empty) return "select the statements to extract";
  await whenSynced(view);
  const doc = view.state.doc;
  const p: Prepared = { view, ctx, doc };

  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Extract Method needs the language server here";

  const where = await locateBlock(p, sel);
  if (typeof where === "string") return where;
  const { statement, block, owner } = where;
  // `statement` is the block's direct child holding the selection's start. A
  // selection that starts inside a construct (`except`, `else`, a `case` body)
  // begins before that statement, and would extract half a clause.
  if (doc.lineAt(spanOf(doc, statement).from).from !== doc.lineAt(sel.from).from) {
    return "the selection must start at a statement of the enclosing block";
  }
  if (statement.hasError) return "the selection contains syntax errors";
  if (!owner) return "select statements inside a function";
  if (!/^(function_definition|decorated_definition)$/.test(owner.kind)) {
    return "select statements inside a function";
  }

  const range = wholeStatements(doc, sel.from, sel.to);
  if (typeof range === "string") return range;
  const { from, to, indent } = range;

  // A syntax error anywhere in the selection makes every later answer a guess.
  const broken = await structure.syntaxErrors(ctx.doc).catch(() => null);
  if (broken?.errors.some((e) => spanOf(doc, e).to > from && spanOf(doc, e).from < to)) {
    return "the selection contains syntax errors";
  }

  const fnSpan = spanOf(doc, owner);
  void block;

  const flow = await analyze(p, from, to, doc.sliceString(fnSpan.from, fnSpan.to));
  if (typeof flow === "string") return flow;

  return {
    from,
    to,
    body: doc.sliceString(from, to),
    bodyIndent: indent,
    // The new `def` sits beside the enclosing function, so every name already
    // in scope there stays in scope inside the extracted body.
    defIndent: indentOf(doc, fnSpan.from),
    bodyIndentInner: `${indentOf(doc, fnSpan.from)}    `,
    insertAt: doc.lineAt(fnSpan.to).to,
    params: flow.params,
    output: flow.output,
  };
}

/** The `def` text, the selection's indent replaced by the new body's. */
export function declarationText(plan: ExtractPlan, name: string): string {
  const body = plan.body
    .split("\n")
    .map((line) => (blank(line) ? "" : plan.bodyIndentInner + line.slice(plan.bodyIndent.length)))
    .join("\n");
  const tail = plan.output ? `\n${plan.bodyIndentInner}return ${plan.output}` : "";
  return `${plan.defIndent}def ${name}(${plan.params.join(", ")}):\n${body}${tail}`;
}

/** The call that replaces the selection. */
export function callText(plan: ExtractPlan, name: string): string {
  const call = `${name}(${plan.params.join(", ")})`;
  return plan.output ? `${plan.bodyIndent}${plan.output} = ${call}` : `${plan.bodyIndent}${call}`;
}

type Builder = (name: string, state: EditorState) => ChangeSet;

function builder(plan: ExtractPlan): Builder {
  return (name, state) =>
    state.changes([
      { from: plan.from, to: plan.to, insert: callText(plan, name) },
      { from: plan.insertAt, insert: `\n\n${declarationText(plan, name)}` },
    ]);
}

/** Offsets of the new name in the applied document (for the rename popup). */
function nameRange(plan: ExtractPlan, name: string, applied: Text): { from: number; to: number } {
  const at = applied.toString().indexOf(`def ${name}`, plan.insertAt);
  const start = at < 0 ? plan.insertAt : at + "def ".length;
  return { from: start, to: start + name.length };
}

function applyAndName(p: Prepared, plan: ExtractPlan, names: string[]) {
  const { view } = p;
  if (view.state.doc !== p.doc) {
    showHint(view, tx`The document changed; invoke the refactoring again`);
    return;
  }
  const original = view.state.doc;
  const name = names[0]!;
  const build = builder(plan);
  view.dispatch({
    changes: build(name, view.state),
    selection: { anchor: plan.from },
    scrollIntoView: true,
    userEvent: "refactor.extractMethod",
  });
  const applied = view.state.doc;
  const ranges = nameRange(plan, name, applied);
  view.focus();
  openPopup({
    kind: "rename",
    anchor: caretAnchor(view, ranges.from),
    title: "Name for the new method",
    initial: name,
    suggestions: names,
    hint: tx`↵ Apply · Esc Keep '${name}'`,
    onSubmit: (chosen) => void rename(p, chosen, name, { original, applied, plan, build, ranges }),
  });
}

async function rename(
  p: Prepared,
  chosen: string,
  current: string,
  st: {
    original: Text;
    applied: Text;
    plan: ExtractPlan;
    build: Builder;
    ranges: { from: number; to: number };
  },
) {
  const { view } = p;
  const name = chosen.trim();
  if (!name || name === current) return;
  if (!isIdentifier(name) || isKeyword(name)) {
    showHint(view, tx`'${chosen}' is not a valid name; kept '${current}'`, { tone: "warning" });
    return;
  }
  if (view.state.doc !== st.applied) {
    showHint(view, tx`The document changed; the name was not applied`);
    return;
  }
  // Redo the whole refactoring with the chosen name, so it stays one undo step.
  const redone = undo(view) && view.state.doc.eq(st.original) ? st.build(name, view.state) : null;
  if (!redone) {
    if (view.state.doc !== st.applied) redo(view);
    if (view.state.doc !== st.applied) return;
    view.dispatch({
      changes: [{ from: st.ranges.from, to: st.ranges.to, insert: name }],
      userEvent: "refactor.rename",
    });
    return;
  }
  const ranges = nameRange(st.plan, name, view.state.doc);
  view.dispatch({
    changes: redone,
    selection: { anchor: ranges.to },
    scrollIntoView: true,
    userEvent: "refactor.extractMethod",
  });
}

async function suggestionsFor(p: Prepared, plan: ExtractPlan): Promise<string[]> {
  const taken = async (name: string) => {
    const found = await structure.identifiers(p.ctx.doc, name).catch(() => []);
    return found.some((o) => !o.qualified);
  };
  // IDEA names the method after what it produces; the body of an extraction is
  // statements, so `suggestNames` has little to read. Fall back to IDEA's own
  // `extracted` when nothing better comes out.
  const style = nameStyle(p.ctx.language);
  const fromOutput = plan.output && (style === "snake" ? `compute_${plan.output}` : `compute${cap(plan.output)}`);
  const raw = fromOutput ?? (style === "snake" ? "extracted" : "extracted");
  return uniqueNames([raw, style === "snake" ? "extracted" : "extracted"], taken);
}

/**
 * Runs the refactoring. Returns whether the document changed, like
 * `introduceFallback`, so the caller can tell a refusal from a no-op.
 */
export async function extractMethodFallback(view: EditorView): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) {
    showHint(view, tx`Cannot perform refactoring: the file is read-only`);
    return true;
  }
  const before = view.state.doc;
  try {
    const planned = await planExtract(view);
    if (typeof planned === "string") {
      showHint(view, tx`Cannot perform refactoring: ${planned}`);
      return true;
    }
    if (view.state.doc !== before) {
      showHint(view, tx`The document changed; invoke the refactoring again`);
      return true;
    }
    const p: Prepared = { view, ctx, doc: view.state.doc };
    const names = await suggestionsFor(p, planned);
    applyAndName(p, planned, names);
    return view.state.doc !== before;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return view.state.doc !== before;
  }
}
