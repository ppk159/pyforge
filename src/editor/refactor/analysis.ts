/**
 * Small, shared primitives over the document and the syntax tree.
 *
 * Everything here is pure offset arithmetic or a single query to the structure
 * service. The refactorings (`extractMethod`, `inline`, …) build on them so that
 * "the statement I am in", "this range is written" and "these offsets are
 * inside that span" mean the same thing everywhere.
 */
import type { Text } from "@codemirror/state";
import type { Pos, Range, SyntaxNode } from "@/bindings";
import type { EditorDocContext } from "@/editor/api";
import { structure } from "@/editor/structure";
import { rangeToOffsets } from "@/editor/lsp/positions";

/** A span of the document in CodeMirror offsets; `to` is exclusive. */
export interface Span {
  from: number;
  to: number;
}

/** Offset → 0-based line, UTF-16 column. */
export function posAt(doc: Text, offset: number): Pos {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, col: offset - line.from };
}

/** Offsets of a `Range` (definitions and references arrive as ranges, not nodes). */
export function offsetsOf(doc: Text, range: Range): Span {
  return rangeToOffsets(doc, range);
}

/** Offsets of a node in the document. */
export function spanOf(doc: Text, node: { range: Range }): Span {
  return rangeToOffsets(doc, node.range);
}

/** Leading whitespace of the line `pos` is on. */
export function indentOf(doc: Text, pos: number): string {
  return /^[ \t]*/.exec(doc.lineAt(pos).text)![0];
}

export function isBlankLine(line: string): boolean {
  return !line.trim();
}

/** `inner` lies entirely inside `[from, to)`. */
export function withinRange(inner: Span, from: number, to: number): boolean {
  return inner.from >= from && inner.to <= to;
}

/** First non-whitespace offset of `[from, to)`, or `from` when all of it is. */
export function firstContent(doc: Text, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const c = doc.sliceString(i, i + 1);
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return i;
  }
  return from;
}

/** Node kinds whose direct children are statements. */
export const BLOCKISH =
  /^(block|chunk|statement_list|program|module|source_file|compound_statement|statement_block|body|do_block|statements|declaration_list|class_body|template_body)$/;

/** The node at `range`, its ancestors innermost-first. */
export async function chainAt(ctx: EditorDocContext, range: Range): Promise<SyntaxNode[] | null> {
  const n = await structure.nodeAt(ctx.doc, range).catch(() => null);
  return n ? [n.node, ...n.ancestors] : null;
}

/**
 * Whether `range` is written rather than read: an assignment target, a `for`
 * target, an `as` binding or a walrus target.
 */
export async function isWriteTarget(ctx: EditorDocContext, range: Range): Promise<boolean> {
  const chain = await chainAt(ctx, range);
  if (!chain) return false;
  for (let i = 0; i + 1 < chain.length; i++) {
    const node = chain[i]!;
    const parent = chain[i + 1]!;
    if (node.field === "left" && /assignment|for_statement|for_in_clause/.test(parent.kind)) return true;
    if (node.field === "alias" && /as_pattern/.test(parent.kind)) return true;
    if (node.field !== "value" && /named_expression/.test(parent.kind)) return true;
  }
  return false;
}

/** A statement of a block, and the declaration that owns the block. */
export interface StatementAt {
  statement: SyntaxNode;
  block: SyntaxNode;
  /** Usually the enclosing function declaration. */
  owner: SyntaxNode | undefined;
}

/**
 * The statement list a position belongs to, and the statement holding it.
 *
 * Walks the ancestors of the node at `pos` instead of asking `expressionAt`:
 * that answers for *expressions*, and over a multi-line statement block it
 * reports the enclosing declaration rather than the statement inside it.
 */
export async function statementAt(ctx: EditorDocContext, doc: Text, pos: number): Promise<StatementAt | null> {
  const at = posAt(doc, pos);
  const chain = await chainAt(ctx, { start: at, end: at });
  if (!chain) return null;
  for (let i = 0; i + 1 < chain.length; i++) {
    const node = chain[i]!;
    const parent = chain[i + 1]!;
    if (BLOCKISH.test(node.kind) || !BLOCKISH.test(parent.kind)) continue;
    return { statement: node, block: parent, owner: chain[i + 2] };
  }
  return null;
}

/**
 * Whether the enclosing function *signature* binds `name`.
 *
 * Used when `locals` cannot resolve a name: either the scope query missed a
 * parameter (a local), or the name is module-level (`Task`, `len`) and stays in
 * scope anyway, so passing it would be wrong.
 *
 * Only the parameter list is examined. Scanning the body would read
 * `task = Task(…)` as binding `Task`, because `Task` follows the `=`.
 */
export function signatureBinds(ownerText: string, name: string): boolean {
  const open = ownerText.indexOf("(");
  if (open < 0) return false;
  let depth = 0;
  let close = -1;
  for (let i = open; i < ownerText.length; i++) {
    const c = ownerText[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  const signature = ownerText.slice(open + 1, close < 0 ? ownerText.length : close);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])${escaped}\\s*($|[:,)=]|=(?!=))`).test(signature);
}
