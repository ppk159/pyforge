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

const { isWriteTarget, assignmentWindow, insideWindow, duplicationRunsElsewhere } = await import("./analysis");

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

describe("assignmentWindow", () => {
  it("ends at the next write after the declaration", () => {
    const decl = { from: 13, to: 19 };
    const next = { from: 34, to: 39 };
    expect(assignmentWindow(decl, [decl, next], 100)).toEqual({ from: 19, to: 34 });
  });

  it("runs to the end of the scope when nothing writes again", () => {
    const decl = { from: 13, to: 19 };
    expect(assignmentWindow(decl, [decl], 100)).toEqual({ from: 19, to: 100 });
  });

  it("ignores a write before the declaration", () => {
    const decl = { from: 13, to: 19 };
    const earlier = { from: 0, to: 5 };
    expect(assignmentWindow(decl, [earlier, decl], 100)).toEqual({ from: 19, to: 100 });
  });
});

describe("insideWindow", () => {
  it("accepts a span inside and rejects one past the end", () => {
    const w = { from: 19, to: 34 };
    expect(insideWindow({ from: 20, to: 25 }, w)).toBe(true);
    expect(insideWindow({ from: 35, to: 39 }, w)).toBe(false);
  });
});

describe("duplicationRunsElsewhere", () => {
  const text = "x".repeat(60);

  it("does not object to a single use", () => {
    expect(duplicationRunsElsewhere(1, true, [{ from: 0, to: 1 }], text)).toBe(false);
  });

  it("does not object when the initializer cannot run anything", () => {
    expect(
      duplicationRunsElsewhere(
        2,
        false,
        [
          { from: 0, to: 1 },
          { from: 40, to: 41 },
        ],
        text,
      ),
    ).toBe(false);
  });

  it("accepts adjacent uses even when the initializer can run", () => {
    // `total + total`: only an operator between them.
    expect(
      duplicationRunsElsewhere(
        2,
        true,
        [
          { from: 0, to: 5 },
          { from: 8, to: 13 },
        ],
        "total + total",
      ),
    ).toBe(false);
  });

  it("objects when a statement separates the uses", () => {
    // `a; b`: a `;` is in the allowed set, but a newline plus an identifier is not.
    expect(
      duplicationRunsElsewhere(
        2,
        true,
        [
          { from: 0, to: 5 },
          { from: 30, to: 35 },
        ],
        "total\nprint()\ntotal",
      ),
    ).toBe(true);
  });
});
