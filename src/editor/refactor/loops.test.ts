import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { IdentifierOccurrence, NodeAt, Range, SyntaxErrors, SyntaxNode } from "@/bindings";

// --- a hand-built syntax tree over the test document -------------------------

interface FakeNode {
  kind: string;
  from: number;
  to: number;
  field: string | null;
  parent: FakeNode | null;
}

const H = vi.hoisted(() => ({ text: "", nodes: [] as FakeNode[] }));

const posOf = (off: number) => {
  const line = Text.of(H.text.split("\n")).lineAt(off);
  return { line: line.number - 1, col: off - line.from };
};
const offOf = (p: { line: number; col: number }) => Text.of(H.text.split("\n")).line(p.line + 1).from + p.col;
const rangeOf = (from: number, to: number): Range => ({ start: posOf(from), end: posOf(to) });

function toSyntax(n: FakeNode): SyntaxNode {
  return {
    kind: n.kind,
    range: rangeOf(n.from, n.to),
    field: n.field,
    named: true,
    error: false,
    missing: false,
    hasError: false,
  };
}

/** `[kind, needle, nth?, field?]`, outer → inner. */
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

function nodeAt(range: Range): NodeAt | null {
  const from = offOf(range.start);
  const to = offOf(range.end);
  let best: FakeNode | null = null;
  for (const n of H.nodes)
    if (n.from <= from && n.to >= to && (!best || n.to - n.from <= best.to - best.from)) best = n;
  if (!best) return null;
  const ancestors: SyntaxNode[] = [];
  for (let p = best.parent; p; p = p.parent) ancestors.push(toSyntax(p));
  return { node: toSyntax(best), ancestors };
}

const structureMock = {
  support: vi.fn(async () => ({ tree: true, locals: true })),
  nodeAt: vi.fn(async (_doc: number, range: Range) => nodeAt(range)),
  identifiers: vi.fn(async (_doc: number, name: string) => {
    const out: IdentifierOccurrence[] = [];
    for (const m of H.text.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))) {
      out.push({
        range: rangeOf(m.index!, m.index! + name.length),
        kind: "identifier",
        qualified: false,
        role: "other",
      });
    }
    return out;
  }),
  syntaxErrors: vi.fn(async (): Promise<SyntaxErrors> => ({ errors: [], truncated: false })),
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { lspDoc } = await import("@/editor/lsp/lsp");
const { clausesOf, topLevelKeyword, planComprehensionToLoop, planLoopToComprehension, loopToComprehension } =
  await import("./loops");

let view: EditorView | null = null;

function editor(doc: string, caret: number) {
  H.text = doc;
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [
        history(),
        lspDoc.of({ doc: 1, path: "/p/a.py", language: "python", uiMode: null, readOnly: false }),
      ],
    }),
  });
  return view;
}

beforeEach(() => {
  H.text = "";
  H.nodes = [];
  showHint.mockClear();
});

afterEach(() => {
  view?.destroy();
  view = null;
});

// ---------------------------------------------------------------------------

describe("reading a comprehension's header", () => {
  it("finds a keyword only at bracket depth zero", async () => {
    expect(topLevelKeyword("x for x in items", "for")).toBe(2);
    // A `for` inside a call is part of the iterable, not a clause.
    expect(topLevelKeyword("x in f(a for a in b)", "in")).toBe(2);
    expect(topLevelKeyword("f(a for a in b)", "for")).toBe(-1);
  });

  it("splits clauses left to right, with the tests of each", async () => {
    expect(clausesOf("for x in items if p(x) if q(x)")).toEqual([
      { target: "x", iterable: "items", conditions: ["p(x)", "q(x)"] },
    ]);
    expect(clausesOf("for x in a for y in b if c")).toEqual([
      { target: "x", iterable: "a", conditions: [] },
      { target: "y", iterable: "b", conditions: ["c"] },
    ]);
  });

  it("keeps a nested comprehension's clauses with its own iterable", async () => {
    expect(clausesOf("for x in [y for y in z] if p(x)")).toEqual([
      { target: "x", iterable: "[y for y in z]", conditions: ["p(x)"] },
    ]);
  });

  it("refuses a header it cannot split", async () => {
    expect(clausesOf("in items")).toBe("the comprehension's clauses could not be read");
    expect(clausesOf("for x items")).toBe("the comprehension's clauses could not be read");
  });
});

describe("planComprehensionToLoop", () => {
  it("turns a filtered list comprehension into an appending loop", async () => {
    const src = ["def f(items):", "    squares = [x * x for x in items if x > 0]", "    return squares", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    squares = [x * x for x in items if x > 0]\n    return squares", 0, "body"],
      ["expression_statement", "    squares = [x * x for x in items if x > 0]"],
      ["assignment", "squares = [x * x for x in items if x > 0]"],
      ["identifier", "squares", 0, "left"],
      ["list_comprehension", "[x * x for x in items if x > 0]", 0, "right"],
    ]);
    const v = editor(src, src.indexOf("x * x") + 1);
    H.text = src;
    const plan = await planComprehensionToLoop(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe(
      ["    squares = []", "    for x in items:", "        if x > 0:", "            squares.append(x * x)"].join("\n"),
    );
  });

  it("nests a clause that iterates over another", async () => {
    const src = ["pairs = [(a, b) for a in xs for b in ys]", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["expression_statement", src.trimEnd()],
      ["assignment", "pairs = [(a, b) for a in xs for b in ys]"],
      ["identifier", "pairs", 0, "left"],
      ["list_comprehension", "[(a, b) for a in xs for b in ys]", 0, "right"],
    ]);
    const v = editor(src, src.indexOf("(a, b)") + 1);
    const plan = await planComprehensionToLoop(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe(
      ["pairs = []", "for a in xs:", "    for b in ys:", "        pairs.append((a, b))"].join("\n"),
    );
  });

  it("builds a set with add and a dict with item assignment", async () => {
    const setSrc = ["seen = {x for x in items}", ""].join("\n");
    H.text = setSrc;
    tree([
      ["module", setSrc.trimEnd()],
      ["expression_statement", setSrc.trimEnd()],
      ["assignment", "seen = {x for x in items}"],
      ["identifier", "seen", 0, "left"],
      ["set_comprehension", "{x for x in items}", 0, "right"],
    ]);
    let v = editor(setSrc, setSrc.indexOf("{x") + 1);
    let plan = await planComprehensionToLoop(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe(["seen = set()", "for x in items:", "    seen.add(x)"].join("\n"));
    view?.destroy();

    const dictSrc = ["index = {k: f(k) for k in keys}", ""].join("\n");
    H.text = dictSrc;
    tree([
      ["module", dictSrc.trimEnd()],
      ["expression_statement", dictSrc.trimEnd()],
      ["assignment", "index = {k: f(k) for k in keys}"],
      ["identifier", "index", 0, "left"],
      ["dictionary_comprehension", "{k: f(k) for k in keys}", 0, "right"],
    ]);
    v = editor(dictSrc, dictSrc.indexOf("{k") + 1);
    plan = await planComprehensionToLoop(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe(["index = {}", "for k in keys:", "    index[k] = f(k)"].join("\n"));
  });

  it("refuses a comprehension with nowhere to put the result", async () => {
    const src = ["return [x for x in items]", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["return_statement", src.trimEnd()],
      ["list_comprehension", "[x for x in items]"],
    ]);
    const v = editor(src, src.indexOf("x for") + 1);
    expect(await planComprehensionToLoop(v)).toBe("assign the comprehension to a name first");
  });

  it("refuses a subscript target, which would be re-evaluated per item", async () => {
    const src = ["d[k] = [x for x in items]", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["expression_statement", src.trimEnd()],
      ["assignment", "d[k] = [x for x in items]"],
      ["list_comprehension", "[x for x in items]", 0, "right"],
    ]);
    const v = editor(src, src.indexOf("x for") + 1);
    expect(await planComprehensionToLoop(v)).toBe("assign the comprehension to a plain name first");
  });
});

describe("planLoopToComprehension", () => {
  const SRC = [
    "def f(items):",
    "    squares = []",
    "    for x in items:",
    "        if keep(x):",
    "            squares.append(x * x)",
    "    return squares",
    "",
  ].join("\n");

  it("turns an appending loop into a comprehension", async () => {
    H.text = SRC;
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", SRC.trimEnd()],
      ["block", SRC.slice(SRC.indexOf("    squares")), 0, "body"],
      ["expression_statement", "    squares = []"],
      ["assignment", "squares = []"],
      ["for_statement", "    for x in items:\n        if keep(x):\n            squares.append(x * x)", 0, "body"],
    ]);
    const v = editor(SRC, SRC.indexOf("for x in items") + 5);
    const plan = await planLoopToComprehension(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe("    squares = [x * x for x in items if keep(x)]");
  });

  it("refuses when the loop variable outlives the loop", async () => {
    const src = ["    squares = []", "    for x in items:", "        squares.append(x)", "    return x", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.trimEnd(), 0, "body"],
      ["expression_statement", "    squares = []"],
      ["assignment", "squares = []"],
      ["for_statement", "    for x in items:\n        squares.append(x)", 0, "body"],
    ]);
    const v = editor(src, src.indexOf("for x in items") + 5);
    // A comprehension binds `x` in its own scope, so `return x` would stop working.
    expect(await planLoopToComprehension(v)).toBe("the loop variable 'x' is read after the loop");
  });

  it("refuses a loop that does more than append", async () => {
    const src = ["    out = []", "    for x in items:", "        log(x)", "        out.append(x)", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.trimEnd(), 0, "body"],
      ["expression_statement", "    out = []"],
      ["assignment", "out = []"],
      ["for_statement", "    for x in items:\n        log(x)\n        out.append(x)", 0, "body"],
    ]);
    const v = editor(src, src.indexOf("for x in items") + 5);
    expect(await planLoopToComprehension(v)).toBe("the loop's body is not a single append");
  });

  it("refuses a loop that leaves early or has an else clause", async () => {
    const broken = ["    out = []", "    for x in items:", "        out.append(x)", "        break", ""].join("\n");
    H.text = broken;
    tree([
      ["module", broken.trimEnd()],
      ["function_definition", broken.trimEnd()],
      ["block", broken.trimEnd(), 0, "body"],
      ["expression_statement", "    out = []"],
      ["assignment", "out = []"],
      ["for_statement", "    for x in items:\n        out.append(x)\n        break", 0, "body"],
    ]);
    let v = editor(broken, broken.indexOf("for x in items") + 5);
    expect(await planLoopToComprehension(v)).toBe("the loop contains 'break'");
    view?.destroy();

    const withElse = [
      "    out = []",
      "    for x in items:",
      "        out.append(x)",
      "    else:",
      "        pass",
      "",
    ].join("\n");
    H.text = withElse;
    tree([
      ["module", withElse.trimEnd()],
      ["function_definition", withElse.trimEnd()],
      ["block", withElse.trimEnd(), 0, "body"],
      ["expression_statement", "    out = []"],
      ["assignment", "out = []"],
      ["for_statement", "    for x in items:\n        out.append(x)\n    else:\n        pass", 0, "body"],
    ]);
    v = editor(withElse, withElse.indexOf("for x in items") + 5);
    expect(await planLoopToComprehension(v)).toBe("the loop has an else clause");
  });

  it("refuses a loop that does not start from an empty collection", async () => {
    const src = ["    out = [1]", "    for x in items:", "        out.append(x)", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.trimEnd(), 0, "body"],
      ["expression_statement", "    out = [1]"],
      ["assignment", "out = [1]"],
      ["for_statement", "    for x in items:\n        out.append(x)", 0, "body"],
    ]);
    const v = editor(src, src.indexOf("for x in items") + 5);
    expect(await planLoopToComprehension(v)).toBe("the loop does not follow an empty collection");
  });
});

describe("loopToComprehension", () => {
  it("applies in one undoable step", async () => {
    const src = ["out = []", "for x in items:", "    out.append(x)", "", "use(out)", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["expression_statement", "out = []"],
      ["assignment", "out = []"],
      ["for_statement", "for x in items:\n    out.append(x)"],
      ["expression_statement", "use(out)"],
      ["call", "use(out)"],
    ]);
    const v = editor(src, src.indexOf("for x") + 1);
    expect(await loopToComprehension(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(["out = [x for x in items]", "", "use(out)", ""].join("\n"));
    undo({ state: v.state, dispatch: v.state.update.bind(v.state) as never });
    expect(showHint).not.toHaveBeenCalled();
  });

  it("reports a refusal as handled, leaving the document alone", async () => {
    const src = ["x = 1", "for a in items:", "    use(a)", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["expression_statement", "x = 1"],
      ["assignment", "x = 1"],
      ["for_statement", "for a in items:\n    use(a)"],
    ]);
    const v = editor(src, src.indexOf("for a") + 1);
    expect(await loopToComprehension(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(src);
    expect(showHint).toHaveBeenCalledWith(v, expect.stringContaining("the loop's body is not a single append"));
  });
});
