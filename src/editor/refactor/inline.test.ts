import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { ExpressionAt, IdentifierOccurrence, Locals, NodeAt, Range, SyntaxErrors, SyntaxNode } from "@/bindings";

// --- a hand-built syntax tree over the test document -------------------------
//
// Specs are `[kind, needle, nth, field]`, outer → inner, so a fixture reads like
// the tree-sitter tree it stands for:
//   module > function_definition > block > expression_statement > assignment
//     > identifier(left) / binary_operator(right)

interface FakeNode {
  kind: string;
  from: number;
  to: number;
  field: string | null;
  parent: FakeNode | null;
}

const H = vi.hoisted(() => ({
  text: "",
  nodes: [] as FakeNode[],
  localAt: new Map<number, unknown>(),
}));

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

/** The smallest node covering `range`, with its ancestors (`nodeAt`). */
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
  locals: vi.fn(async (_doc: number, pos: { line: number; col: number }) => {
    const off = Text.of(H.text.split("\n")).line(pos.line + 1).from + pos.col;
    const exact = H.localAt.get(off);
    if (exact) return exact as Locals;
    // The real query accepts any position inside the identifier.
    const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
    let start = off;
    while (start > 0 && isWord(H.text[start - 1])) start--;
    let end = off;
    while (end < H.text.length && isWord(H.text[end])) end++;
    const known = end > start ? H.localAt.get(start) : undefined;
    return (known as Locals | undefined) ?? { status: "noIdentifier" as const };
  }),
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
  expressionAt: vi.fn(async (): Promise<ExpressionAt> => {
    throw new Error("unused");
  }),
  syntaxErrors: vi.fn(async (): Promise<SyntaxErrors> => ({ errors: [], truncated: false })),
  structuralRanges: vi.fn(async () => {
    throw new Error("unused");
  }),
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/p" } }) } }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { lspDoc } = await import("@/editor/lsp/lsp");
const { planInline, inlineFallback, replacementFor } = await import("./inline");

// --- editor -------------------------------------------------------------------

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

interface SymbolSpec {
  name: string;
  kind?: "var" | "parameter" | "function" | "type" | "import";
  def: number;
  refs: number[];
  certain?: boolean;
}

/** Registers a `locals` answer at the declaration and at every reference. */
function local(spec: SymbolSpec) {
  const answer: Locals = {
    status: "local",
    symbol: {
      name: spec.name,
      kind: spec.kind ?? "var",
      definition: rangeOf(spec.def, spec.def + spec.name.length),
      scope: rangeOf(0, H.text.length),
      references: spec.refs.map((r) => rangeOf(r, r + spec.name.length)),
      certain: spec.certain ?? true,
      conflicts: [],
    },
  };
  H.localAt.set(spec.def, answer);
  for (const r of spec.refs) H.localAt.set(r, answer);
}

beforeEach(() => {
  H.localAt = new Map();
  H.nodes = [];
  H.text = "";
});

afterEach(() => {
  view?.destroy();
  view = null;
  showHint.mockClear();
});

// ---------------------------------------------------------------------------

describe("replacementFor", () => {
  const base = { declFrom: 0, declTo: 0, text: "a + 1", uses: [], name: "x" };
  it("wraps an expression that binds looser than its context", () => {
    expect(replacementFor({ ...base, parens: true })).toBe("(a + 1)");
  });
  it("leaves an atom bare", () => {
    expect(replacementFor({ ...base, text: "items", parens: false })).toBe("items");
  });
});

describe("planInline", () => {
  const SRC = ["def f(a):", "    total = a + 1", "    print(total)", "    return total", ""].join("\n");
  const DECL = SRC.indexOf("total = a + 1");
  const USE1 = SRC.indexOf("print(total)") + 6;
  const USE2 = SRC.indexOf("return total") + 7;

  function fixture() {
    H.text = SRC;
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", SRC.trimEnd()],
      ["block", "    total = a + 1\n    print(total)\n    return total", 0, "body"],
      ["expression_statement", "    total = a + 1"],
      ["assignment", "total = a + 1"],
      ["identifier", "total", 0, "left"],
      ["binary_operator", "a + 1", 0, "right"],
    ]);
    local({ name: "total", def: DECL, refs: [USE1, USE2] });
  }

  it("plans the inlining of a read-only local", async () => {
    fixture();
    const v = editor(SRC, DECL + 1);
    const plan = await planInline(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe("a + 1");
    expect(plan.parens).toBe(true);
    expect(plan.uses).toEqual([
      { from: USE1, to: USE1 + 5 },
      { from: USE2, to: USE2 + 5 },
    ]);
    // The declaration's whole line goes, including its line break.
    expect(plan.declFrom).toBe(SRC.indexOf("    total = a + 1"));
    expect(plan.declTo).toBe(SRC.indexOf("    print(total)"));
  });

  it("leaves an atom bare", async () => {
    const src = ["def f(items):", "    first = items", "    return first", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    first = items\n    return first", 0, "body"],
      ["expression_statement", "    first = items"],
      ["assignment", "first = items"],
      ["identifier", "first", 0, "left"],
      ["identifier", "items", 1, "right"],
    ]);
    const def = src.indexOf("first = items");
    local({ name: "first", def, refs: [src.indexOf("return first") + 7] });
    const v = editor(src, def + 1);
    const plan = await planInline(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.parens).toBe(false);
    expect(replacementFor(plan)).toBe("items");
  });

  it("refuses a parameter", async () => {
    fixture();
    const def = SRC.indexOf("(a)") + 1;
    local({ name: "a", kind: "parameter", def, refs: [SRC.indexOf("a + 1")] });
    const v = editor(SRC, def + 1);
    expect(await planInline(v)).toBe("the variable is a parameter; it has no initializer");
  });

  it("refuses a variable that is reassigned", async () => {
    const src = ["def f():", "    x = 1", "    x = 2", "    return x", ""].join("\n");
    H.text = src;
    const first = src.indexOf("x = 1");
    const second = src.indexOf("x = 2");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    x = 1\n    x = 2\n    return x", 0, "body"],
      ["expression_statement", "    x = 1"],
      ["assignment", "x = 1"],
      ["identifier", "x", 0, "left"],
      ["integer", "1", 0, "right"],
      ["expression_statement", "    x = 2"],
      ["assignment", "x = 2"],
      ["identifier", "x", 1, "left"],
    ]);
    local({ name: "x", def: first, refs: [second, src.indexOf("return x") + 7] });
    const v = editor(src, first + 1);
    expect(await planInline(v)).toBe("'x' is reassigned; only a variable assigned once can be inlined");
  });

  it("refuses duplicating an initializer that may have side effects", async () => {
    const src = ["def f(a):", "    total = load(a)", "    print(total)", "    return total", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    total = load(a)\n    print(total)\n    return total", 0, "body"],
      ["expression_statement", "    total = load(a)"],
      ["assignment", "total = load(a)"],
      ["identifier", "total", 0, "left"],
      ["call", "load(a)", 0, "right"],
    ]);
    const def = src.indexOf("total = load(a)");
    local({
      name: "total",
      def,
      refs: [src.indexOf("print(total)") + 6, src.indexOf("return total") + 7],
    });
    const v = editor(src, def + 1);
    expect(await planInline(v)).toBe("'total' is used 2 times and its initializer may have side effects");
  });

  it("allows a side-effecting initializer used once", async () => {
    const src = ["def f(a):", "    total = load(a)", "    return total", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    total = load(a)\n    return total", 0, "body"],
      ["expression_statement", "    total = load(a)"],
      ["assignment", "total = load(a)"],
      ["identifier", "total", 0, "left"],
      ["call", "load(a)", 0, "right"],
    ]);
    const def = src.indexOf("total = load(a)");
    local({ name: "total", def, refs: [src.indexOf("return total") + 7] });
    const v = editor(src, def + 1);
    const plan = await planInline(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe("load(a)");
    expect(plan.parens).toBe(false);
  });

  it("refuses a dependency that changes before the use", async () => {
    const src = ["def f():", "    a = 1", "    x = a + 1", "    a = 5", "    return x", ""].join("\n");
    H.text = src;
    const aDef = src.indexOf("a = 1");
    const xDef = src.indexOf("x = a + 1");
    const aAgain = src.indexOf("a = 5");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    a = 1\n    x = a + 1\n    a = 5\n    return x", 0, "body"],
      ["expression_statement", "    a = 1"],
      ["assignment", "a = 1"],
      ["identifier", "a", 0, "left"],
      ["expression_statement", "    x = a + 1"],
      ["assignment", "x = a + 1"],
      ["identifier", "x", 0, "left"],
      ["binary_operator", "a + 1", 0, "right"],
      ["expression_statement", "    a = 5"],
      ["assignment", "a = 5"],
      ["identifier", "a", 2, "left"],
    ]);
    local({ name: "a", def: aDef, refs: [aAgain] });
    local({ name: "x", def: xDef, refs: [src.indexOf("return x") + 7] });
    const v = editor(src, xDef + 1);
    expect(await planInline(v)).toBe("'a' changes between the declaration and the use of 'x'");
  });

  it("refuses a variable declared by a tuple target", async () => {
    const src = ["def f(pair):", "    a, b = pair", "    return a", ""].join("\n");
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", "    a, b = pair\n    return a", 0, "body"],
      ["expression_statement", "    a, b = pair"],
      ["assignment", "a, b = pair"],
      ["pattern_list", "a, b", 0, "left"],
      ["identifier", "a", 0, "left"],
    ]);
    const def = src.indexOf("a, b = pair");
    local({ name: "a", def, refs: [src.indexOf("return a") + 7] });
    const v = editor(src, def);
    expect(await planInline(v)).toBe("the variable is not declared by a plain `name = value`");
  });

  it("refuses a variable read inside a nested function", async () => {
    const src = ["def f():", "    x = 1", "    def g():", "        return x", "    return g", ""].join("\n");
    H.text = src;
    const def = src.indexOf("x = 1");
    const inner = src.indexOf("return x") + 7;
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def f():\n    x = 1\n    def g():\n        return x\n    return g"],
      ["block", "    x = 1\n    def g():\n        return x\n    return g", 0, "body"],
      ["expression_statement", "    x = 1"],
      ["assignment", "x = 1"],
      ["identifier", "x", 0, "left"],
      ["integer", "1", 0, "right"],
      ["function_definition", "def g():\n        return x"],
      ["block", "        return x", 0, "body"],
      ["return_statement", "        return x"],
      ["identifier", "x", 1],
    ]);
    local({ name: "x", def, refs: [inner] });
    const v = editor(src, def);
    expect(await planInline(v)).toBe("'x' is read inside a nested function, which would move when it is evaluated");
  });

  it("refuses a language without a syntax-only implementation", async () => {
    H.text = "class A {}";
    view = new EditorView({
      state: EditorState.create({
        doc: H.text,
        selection: { anchor: 0 },
        extensions: [
          history(),
          lspDoc.of({ doc: 1, path: "/p/a.java", language: "java", uiMode: null, readOnly: false }),
        ],
      }),
    });
    expect(await planInline(view)).toBe("Inline needs the language server for this language");
  });

  it("refuses when the caret is not on a local", async () => {
    const v = editor("def f():\n    pass\n", 9);
    expect(await planInline(v)).toBe("place the caret on a local variable");
  });

  it("refuses a symbol declared with ambiguity", async () => {
    fixture();
    local({ name: "total", def: DECL, refs: [USE1], certain: false });
    const v = editor(SRC, DECL + 1);
    expect(await planInline(v)).toBe("'total' is declared more than once here");
  });
});

describe("inlineFallback", () => {
  const SRC = ["def f(a):", "    total = a + 1", "    print(total)", "    return total", ""].join("\n");
  const DECL = SRC.indexOf("total = a + 1");

  function fixture() {
    H.text = SRC;
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", SRC.trimEnd()],
      ["block", "    total = a + 1\n    print(total)\n    return total", 0, "body"],
      ["expression_statement", "    total = a + 1"],
      ["assignment", "total = a + 1"],
      ["identifier", "total", 0, "left"],
      ["binary_operator", "a + 1", 0, "right"],
    ]);
    local({
      name: "total",
      def: DECL,
      refs: [SRC.indexOf("print(total)") + 6, SRC.indexOf("return total") + 7],
    });
  }

  it("replaces every use and deletes the declaration, as one undo step", async () => {
    fixture();
    const v = editor(SRC, DECL + 1);
    expect(await inlineFallback(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(["def f(a):", "    print((a + 1))", "    return (a + 1)", ""].join("\n"));
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(SRC);
  });

  it("reports a refusal as handled, leaving the document alone", async () => {
    H.text = SRC;
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", SRC.trimEnd()],
    ]);
    local({ name: "total", kind: "parameter", def: DECL, refs: [SRC.indexOf("print(total)") + 6] });
    const v = editor(SRC, DECL + 1);
    expect(await inlineFallback(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(SRC);
    expect(showHint).toHaveBeenCalledWith(v, expect.stringContaining("the variable is a parameter"));
  });
});
