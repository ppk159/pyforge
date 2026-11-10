/**
 * `isWriteTarget` decides whether a name is assigned; the refactorings use it to
 * refuse rebinding a variable the caller owns. Python's shapes matter: the naive
 * "walk every ancestor" version read `self` in `self.x = 1` as assigned, which is
 * the most common free variable in Python.
 *
 * Each case is one line of Python and the answer a reader would give.
 */
import { describe, expect, it, vi } from "vitest";
import type { NodeAt, Range, SyntaxNode } from "@/bindings";

interface FakeNode {
  kind: string;
  from: number;
  to: number;
  field: string | null;
  parent: FakeNode | null;
}

const H = vi.hoisted(() => ({ text: "", nodes: [] as FakeNode[] }));

function posOf(off: number) {
  const before = H.text.slice(0, off);
  return { line: before.split("\n").length - 1, col: off - (before.lastIndexOf("\n") + 1) };
}

function offsetOf(p: { line: number; col: number }): number {
  const lines = H.text.split("\n");
  let off = 0;
  for (let i = 0; i < p.line; i++) off += (lines[i] ?? "").length + 1;
  return off + p.col;
}

function toSyntax(n: FakeNode): SyntaxNode {
  return {
    kind: n.kind,
    range: { start: posOf(n.from), end: posOf(n.to) },
    field: n.field,
    named: true,
    error: false,
    missing: false,
    hasError: false,
  };
}

/** `[kind, needle, nth?, field?]`, outer → inner, like the tree-sitter tree. */
function tree(specs: Array<[string, string, number?, string?]>) {
  H.nodes = [];
  for (const [kind, needle, nth = 0, field = null] of specs) {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = H.text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`no occurrence ${nth} of ${JSON.stringify(needle)}`);
    const node: FakeNode = { kind, from: at, to: at + needle.length, field, parent: null };
    node.parent = [...H.nodes].reverse().find((n) => n.from <= node.from && n.to >= node.to) ?? null;
    H.nodes.push(node);
  }
}

vi.mock("@/editor/structure", () => ({
  structure: {
    nodeAt: vi.fn(async (_doc: number, range: Range): Promise<NodeAt | null> => {
      const from = offsetOf(range.start);
      const to = offsetOf(range.end);
      let best: FakeNode | null = null;
      for (const n of H.nodes) {
        if (n.from <= from && n.to >= to && (!best || n.to - n.from <= best.to - best.from)) best = n;
      }
      if (!best) return null;
      const ancestors: SyntaxNode[] = [];
      for (let p = best.parent; p; p = p.parent) ancestors.push(toSyntax(p));
      return { node: toSyntax(best), ancestors };
    }),
  },
}));

const { isWriteTarget } = await import("./analysis");

const ctx = { doc: 1, path: "/p/a.py", language: "python", uiMode: null, readOnly: false } as never;

/** Builds the tree for one source line and asks about `word`. */
async function check(src: string, word: string, specs: Array<[string, string, number?, string?]>) {
  H.text = src;
  tree(specs);
  const at = src.indexOf(word);
  return isWriteTarget(ctx, {
    start: { line: 0, col: at },
    end: { line: 0, col: at + word.length },
  });
}

describe("isWriteTarget", () => {
  it("sees a plain assignment target", async () => {
    expect(
      await check("x = 1", "x", [
        ["assignment", "x = 1"],
        ["identifier", "x", 0, "left"],
      ]),
    ).toBe(true);
  });

  it("does not see the object of an attribute assignment", async () => {
    // `self.x = 1` assigns the member, not `self`; `self` sits under
    // `attribute/left`, which the ancestor walk misread as the target.
    const src = "self.x = 1";
    expect(
      await check(src, "self", [
        ["assignment", src],
        ["attribute", "self.x", 0, "left"],
        ["identifier", "self", 0, "object"],
      ]),
    ).toBe(false);
  });

  it("does not see the member name of an attribute assignment", async () => {
    const src = "self.x = 1";
    expect(
      await check(src, "x", [
        ["assignment", src],
        ["attribute", "self.x", 0, "left"],
        ["identifier", "x", 0, "attribute"],
      ]),
    ).toBe(false);
  });

  it("sees a name inside a tuple target", async () => {
    const src = "a, b = pair";
    expect(
      await check(src, "a", [
        ["assignment", src],
        ["pattern_list", "a, b", 0, "left"],
        ["identifier", "a"],
      ]),
    ).toBe(true);
  });

  it("does not see the value of a subscript target", async () => {
    const src = "a[0] = 2";
    expect(
      await check(src, "a", [
        ["assignment", src],
        ["subscript", "a[0]", 0, "left"],
        ["identifier", "a", 0, "value"],
      ]),
    ).toBe(false);
  });

  it("sees an augmented assignment target", async () => {
    const src = "c += 3";
    expect(
      await check(src, "c", [
        ["augmented_assignment", src],
        ["identifier", "c", 0, "left"],
      ]),
    ).toBe(true);
  });

  it("sees a for-loop target", async () => {
    const src = "for k in items:";
    expect(
      await check(src, "k", [
        ["for_statement", src],
        ["identifier", "k", 0, "left"],
      ]),
    ).toBe(true);
  });

  it("sees a with-as binding", async () => {
    const src = "with open(p) as fh:";
    expect(
      await check(src, "fh", [
        ["with_item", src],
        ["as_pattern", "open(p) as fh", 0, "value"],
        ["as_pattern_target", "fh", 0, "alias"],
        ["identifier", "fh"],
      ]),
    ).toBe(true);
  });

  it("sees a walrus target", async () => {
    const src = "if (y := g(x)):";
    expect(
      await check(src, "y", [
        ["if_statement", src],
        ["named_expression", "(y := g(x))"],
        ["identifier", "y", 0, "name"],
      ]),
    ).toBe(true);
  });

  it("does not see the value side of a walrus", async () => {
    const src = "if (y := g(x)):";
    expect(
      await check(src, "x", [
        ["if_statement", src],
        ["named_expression", "(y := g(x))"],
        ["call", "g(x)", 0, "value"],
        ["identifier", "x"],
      ]),
    ).toBe(false);
  });

  it("does not see a read", async () => {
    const src = "print(total)";
    expect(
      await check(src, "total", [
        ["expression_statement", src],
        ["call", "print(total)"],
        ["identifier", "total"],
      ]),
    ).toBe(false);
  });
});
