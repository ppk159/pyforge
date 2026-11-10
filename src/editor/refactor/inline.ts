/**
 * Inline Variable (⌃⌥N) without the language server, from the tree-sitter
 * structure service (IDEA's "dumb mode"). Called by the LSP actions only when
 * the server is not usable, or answered nothing.
 *
 * Scope of the syntax-only implementation:
 *  - a local declared by one plain `x = <expr>` in Python;
 *  - every use is a read, the declaration is deleted, and the whole thing is one
 *    undo step;
 *  - anything the syntax cannot decide is refused with a hint, never guessed.
 *
 * The two ways inlining goes *wrong* are covered: duplicating an expression that
 * has a side effect, and moving an expression across a change to what it reads.
 */
import type { ChangeSet, EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Locals, LocalSymbol } from "@/bindings";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import {
  assignmentWindow,
  chainAt,
  duplicationRunsElsewhere,
  insideWindow,
  isWriteTarget,
  offsetsOf,
  posAt,
  spanOf,
  type Span,
} from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

/**
 * Node kinds an initializer may have and still be duplicated safely: reading a
 * name, a member, a subscript, a literal, or arithmetic over them runs nothing.
 * `string` is checked separately: an f-string can interpolate a call.
 */
const PURE_NODE =
  /^(identifier|attribute|subscript|integer|float|concatenated_string|true|false|none|list|dictionary|set|tuple|parenthesized_expression|binary_operator|comparison_operator|boolean_operator|unary_operator|not_operator|conditional_expression|list_comprehension|dictionary_comprehension|set_comprehension)$/;

/** Kinds that already bind tighter than any surrounding operator, so no `()`. */
const ATOM_NODE =
  /^(identifier|attribute|subscript|call|integer|float|string|concatenated_string|true|false|none|list|dictionary|set|tuple|parenthesized_expression|list_comprehension|dictionary_comprehension|set_comprehension|generator_expression)$/;

/** An f-string may interpolate a call, so it is not safe to duplicate. */
function mayRunSomething(kind: string, text: string): boolean {
  if (kind === "string") return /^[rRbBuU]*[fF]/.test(text);
  return !PURE_NODE.test(kind);
}

/** Declarations whose body runs later, so inlining into them moves evaluation. */
const FUNCTION_NODE = /^(function_definition|lambda|decorated_definition)$/;

export interface InlinePlan {
  /** The declaration's lines, including the trailing line break. */
  declFrom: number;
  declTo: number;
  /** The initializer text, trimmed. */
  text: string;
  /** Uses to replace, in document order. */
  uses: Span[];
  /** Wrap `text` in parentheses at each use. */
  parens: boolean;
  name: string;
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

/** The local the caret is on, or the one identifier the selection covers. */
async function localUnderCaret(p: Prepared): Promise<Locals | string> {
  const sel = p.view.state.selection.main;
  const answer = await structure
    .locals(p.ctx.doc, posAt(p.doc, sel.from))
    .catch((e: unknown) => `the scope query failed (${String(e)})`);
  if (typeof answer === "string") return answer;
  if (answer.status !== "local" || sel.empty) return answer;
  // A selection must cover exactly the name: a half-selected line is not a
  // deliberate "inline this variable".
  const def = offsetsOf(p.doc, answer.symbol.definition);
  if (def.from < sel.from || def.to > sel.to) return "the selection does not name one variable";
  return answer;
}

/**
 * The `x = <expr>` statement declaring `symbol`: whole lines, and the
 * initializer's offsets. Refuses anything with a target more complex than one
 * name, or an initializer that is itself an assignment.
 */
async function declarationOf(
  p: Prepared,
  symbol: LocalSymbol,
): Promise<{ lines: Span; init: Span; initKind: string } | string> {
  if (symbol.kind === "parameter") return "the variable is a parameter; it has no initializer";
  if (symbol.kind !== "var") return `the variable is a ${symbol.kind}, not a local assignment`;

  const def = offsetsOf(p.doc, symbol.definition);
  const chain = await chainAt(p.ctx, symbol.definition);
  if (!chain) return "the declaration could not be located";
  const self = chain.findIndex((n) => {
    const s = offsetsOf(p.doc, n.range);
    return s.from === def.from && s.to === def.to;
  });
  const node = self >= 0 ? chain[self]! : undefined;
  const parent = self >= 0 ? chain[self + 1] : undefined;
  // `name = …` only: `a, b = …` puts a pattern list here, `a += …` an augmented
  // assignment, `for a in …` a for statement. The field lives on the child.
  if (!node || !parent || parent.kind !== "assignment" || node.field !== "left") {
    return "the variable is not declared by a plain `name = value`";
  }

  const statement = spanOf(p.doc, parent);
  const eq = p.doc.sliceString(def.to, statement.to).indexOf("=");
  if (eq < 0) return "the declaration has no initializer";
  const afterEq = def.to + eq + 1;
  const from = afterEq + /^[ \t]*/.exec(p.doc.sliceString(afterEq, statement.to))![0].length;
  if (from >= statement.to) return "the declaration has no initializer";

  const initNode = await structure.nodeAt(p.ctx.doc, offsetsToRange(p.doc, from, statement.to)).catch(() => null);
  if (!initNode) return "the initializer could not be located";
  // `x = y = 1` parses as an assignment whose right side is another assignment.
  if (/^(assignment|augmented_assignment)$/.test(initNode.node.kind)) return "the declaration chains assignments";

  const start = statement.from;
  const end = statement.to;
  return {
    lines: { from: p.doc.lineAt(start).from, to: Math.min(p.doc.lineAt(end).to + 1, p.doc.length) },
    init: { from, to: end },
    initKind: initNode.node.kind,
  };
}

/**
 * The first name the initializer reads that is written between `from` and `to`.
 * Moving the expression past such a write would change its value.
 */
async function firstChangedDependency(p: Prepared, text: string, from: number, to: number): Promise<string | null> {
  for (const m of new Set(text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g))) {
    const name = m[0];
    const found = await structure.identifiers(p.ctx.doc, name).catch(() => []);
    for (const occ of found) {
      const span = offsetsOf(p.doc, occ.range);
      if (span.from < from || span.to > to) continue;
      if (await isWriteTarget(p.ctx, occ.range)) return name;
    }
  }
  return null;
}

/**
 * Whether a use sits in a function declared inside the variable's scope: there
 * the expression would run when that function is *called*, not where it is
 * written, so inlining would move the evaluation.
 */
async function insideNestedFunction(p: Prepared, use: Span, declaration: number): Promise<boolean> {
  const chain = await chainAt(p.ctx, offsetsToRange(p.doc, use.from, use.to));
  if (!chain) return false;
  for (const node of chain) {
    if (!FUNCTION_NODE.test(node.kind)) continue;
    const span = spanOf(p.doc, node);
    if (declaration < span.from || declaration > span.to) return true;
  }
  return false;
}

/**
 * Everything that can make the refactoring unsafe is checked before any edit.
 * Returns the reason instead of a plan when it cannot be done.
 */
export async function planInline(view: EditorView): Promise<InlinePlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Inline needs the language server for this language";
  await whenSynced(view);
  const doc = view.state.doc;
  const p: Prepared = { view, ctx, doc };

  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Inline needs the language server here";

  const answer = await localUnderCaret(p);
  if (typeof answer === "string") return answer;
  if (answer.status !== "local") return "place the caret on a local variable";
  const symbol = answer.symbol;
  if (!symbol.certain) return `'${symbol.name}' is declared more than once here`;
  if (!symbol.references.length) return `'${symbol.name}' is never used`;

  const decl = await declarationOf(p, symbol);
  if (typeof decl === "string") return decl;

  const declaration = offsetsOf(p.doc, symbol.definition);
  const uses: Span[] = [];
  /** Every write to the name, including the declaration. */
  const writes: Span[] = [declaration];
  for (const ref of symbol.references) {
    const span = offsetsOf(p.doc, ref);
    const write = await isWriteTarget(p.ctx, ref);
    if (write) writes.push(span);
    // A use inside the declaration's own line is part of the initializer
    // (`x = x + 1` reads the previous `x`), which is not this variable.
    if (span.from >= decl.lines.from && span.to <= decl.lines.to) continue;
    if (write) continue;
    // Reading a local before it is assigned cannot happen in one scope; a use
    // that does is in a nested function that runs later.
    if (span.from < declaration.from) return `'${symbol.name}' is read before it is declared`;
    if (await insideNestedFunction(p, span, declaration.from)) {
      return `'${symbol.name}' is read inside a nested function, which would move when it is evaluated`;
    }
    uses.push(span);
  }
  if (!uses.length) return `'${symbol.name}' is never used`;

  // Reassignment is fine as long as every use of *this* assignment happens before
  // the next write: then inlining cannot change which value a use sees.
  const scope = spanOf(p.doc, { range: symbol.scope });
  const window = assignmentWindow(decl.lines, writes, scope.to);
  const outside = uses.filter((u) => !insideWindow(u, window));
  if (outside.length) {
    return `'${symbol.name}' is reassigned before these uses; only a variable assigned once can be inlined`;
  }

  const text = doc.sliceString(decl.init.from, decl.init.to).trim();
  if (!text) return "the declaration has no initializer";

  // Duplicating an expression that runs something is safe only when the copies
  // are adjacent: nothing else runs between them, so the side effects keep their
  // order and count. Anything in between could observe or change the difference.
  if (duplicationRunsElsewhere(uses.length, mayRunSomething(decl.initKind, text), uses, doc.toString())) {
    return `'${symbol.name}' is used ${uses.length} times and its initializer may have side effects`;
  }

  // Moving the expression to a use must not cross a change to what it reads.
  const changed = await firstChangedDependency(p, text, decl.lines.to, uses[uses.length - 1]!.to);
  if (changed) return `'${changed}' changes between the declaration and the use of '${symbol.name}'`;

  return {
    declFrom: decl.lines.from,
    declTo: decl.lines.to,
    text,
    uses,
    parens: !ATOM_NODE.test(decl.initKind),
    name: symbol.name,
  };
}

/** The replacement for one use: a bare atom, or the expression in parentheses. */
export function replacementFor(plan: InlinePlan): string {
  return plan.parens ? `(${plan.text})` : plan.text;
}

function changesFor(plan: InlinePlan, state: EditorState): ChangeSet {
  return state.changes([
    ...plan.uses.map((u) => ({ from: u.from, to: u.to, insert: replacementFor(plan) })),
    { from: plan.declFrom, to: plan.declTo, insert: "" },
  ]);
}

function apply(p: Prepared, plan: InlinePlan) {
  const { view } = p;
  if (view.state.doc !== p.doc) {
    showHint(view, tx`The document changed; invoke the refactoring again`);
    return;
  }
  const changes = changesFor(plan, view.state);
  const anchor = plan.uses[0] ? changes.mapPos(plan.uses[0].from, -1) : plan.declFrom;
  view.dispatch({ changes, selection: { anchor }, scrollIntoView: true, userEvent: "refactor.inline" });
  view.focus();
}

/**
 * Runs the refactoring. Returns whether the document changed, like
 * `introduceFallback`, so the caller can tell a refusal from a no-op.
 */
export async function inlineFallback(view: EditorView): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const planned = await planInline(view);
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
