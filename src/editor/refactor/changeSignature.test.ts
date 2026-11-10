import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { NodeAt, Range, SyntaxNode } from "@/bindings";

// --- a hand-built syntax tree over the test document -------------------------

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

function rangeOf(from: number, to: number): Range {
  return { start: posOf(from), end: posOf(to) };
}

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

const structureMock = {
  support: vi.fn(async () => ({ tree: true, locals: true })),
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
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/p" } }) } }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { lspDoc } = await import("@/editor/lsp/lsp");
const { parameterItems, paramName, appendParameter, signatureAt, planAppendParameter, appendParameterFallback } =
  await import("./changeSignature");

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

/** The tree for a one-function file: `module > function_definition`. */
function fnTree(doc: string) {
  H.text = doc;
  const bodyEnd = doc.trimEnd().length;
  tree([
    ["module", doc.trimEnd()],
    ["function_definition", doc.slice(0, bodyEnd)],
    ["parameters", doc.slice(doc.indexOf("("), doc.indexOf(")") + 1)],
  ]);
}

beforeEach(() => {
  H.nodes = [];
  H.text = "";
});

afterEach(() => {
  view?.destroy();
  view = null;
  showHint.mockClear();
});

// ---------------------------------------------------------------------------

/** The items of a signature, failing the test when the list cannot be read. */
function items(signature: string) {
  const got = parameterItems(signature);
  if (typeof got === "string") throw new Error(got);
  return got;
}

describe("parameterItems", () => {
  it("reads a plain list", () => {
    expect(parameterItems("def f(a, b)")).toEqual([
      { text: "a", from: 6, to: 7 },
      { text: "b", from: 9, to: 10 },
    ]);
  });

  it("reads an empty list", () => {
    expect(parameterItems("def f()")).toEqual([]);
  });

  it("does not split on a comma inside a default", () => {
    expect(items("def f(a, b=(1, 2), c)").map((i) => i.text)).toEqual(["a", "b=(1, 2)", "c"]);
    expect(items("def f(a, b=g(1, 2))").map((i) => i.text)).toEqual(["a", "b=g(1, 2)"]);
  });

  it("keeps annotations and defaults", () => {
    expect(items("def f(a: int, b: str = 'x')").map((i) => i.text)).toEqual(["a: int", "b: str = 'x'"]);
  });

  it("refuses a signature without a list", () => {
    expect(parameterItems("def f")).toBe("the declaration has no parameter list");
    expect(parameterItems("def f(a")).toBe("the parameter list is not closed");
  });
});

describe("paramName", () => {
  it("reads the name of every shape", () => {
    const name = (text: string) => paramName({ text, from: 0, to: text.length });
    expect(name("a")).toBe("a");
    expect(name("a: int")).toBe("a");
    expect(name("a=1")).toBe("a");
    expect(name("a: int = 1")).toBe("a");
    expect(name("*args")).toBe("args");
    expect(name("**kw")).toBe("kw");
  });
});

describe("appendParameter", () => {
  it("appends after the last parameter", () => {
    expect(appendParameter("def f(a, b)", "c", "0")).toEqual({
      text: "def f(a, b, c=0)",
      parameter: "c=0",
    });
  });

  it("fills an empty list", () => {
    expect(appendParameter("def f()", "c", "0")).toEqual({
      text: "def f(c=0)",
      parameter: "c=0",
    });
  });

  it("keeps the existing annotations", () => {
    expect(appendParameter("def f(a: int)", "b", "1")).toEqual({
      text: "def f(a: int, b=1)",
      parameter: "b=1",
    });
  });

  it("refuses a duplicate name", () => {
    expect(appendParameter("def f(a)", "a", "1")).toBe("the declaration already has a parameter 'a'");
  });

  it("refuses a parameter without a default", () => {
    expect(appendParameter("def f(a)", "b", "  ")).toBe(
      "a new parameter needs a default so existing calls keep working",
    );
  });

  it("refuses an invalid name", () => {
    expect(appendParameter("def f(a)", "1b", "0")).toBe("'1b' is not a valid parameter name");
  });

  it("refuses a declaration taking *args", () => {
    expect(appendParameter("def f(a, *rest)", "b", "0")).toBe("the declaration takes *args or **kwargs");
  });
});

describe("signatureAt", () => {
  it("stops at the colon", async () => {
    const doc = "def f(a, b):\n    return a\n";
    fnTree(doc);
    const v = editor(doc, 5);
    const got = await signatureAt({ view: v, ctx: docOfFor(v), doc: v.state.doc }, 5);
    if (typeof got === "string") throw new Error(got);
    expect(got.text).toBe("def f(a, b)");
  });

  it("does not stop at a colon inside an annotation", async () => {
    const doc = "def f(a: int) -> int:\n    return a\n";
    fnTree(doc);
    const v = editor(doc, 5);
    const got = await signatureAt({ view: v, ctx: docOfFor(v), doc: v.state.doc }, 5);
    if (typeof got === "string") throw new Error(got);
    expect(got.text).toBe("def f(a: int) -> int");
  });
});

function docOfFor(v: EditorView) {
  const ctx = (v as unknown as { state: { facet: (f: unknown) => () => unknown } }).state;
  void ctx;
  // `docOf` reads the `lspDoc` facet; the same object is what the test set up.
  return { doc: 1, path: "/p/a.py", language: "python", uiMode: null, readOnly: false };
}

describe("planAppendParameter", () => {
  const DOC = "def f(a, b):\n    return a + b\n";

  it("plans the new signature", async () => {
    fnTree(DOC);
    const v = editor(DOC, 5);
    const plan = await planAppendParameter(v, "c", "0");
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe("def f(a, b, c=0)");
    expect(plan.parameter).toBe("c=0");
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
    expect(await planAppendParameter(view, "c", "0")).toBe(
      "Change Signature needs the language server for this language",
    );
  });

  it("refuses when the caret is not on a declaration", async () => {
    const doc = "x = 1\n";
    H.text = doc;
    tree([
      ["module", "x = 1"],
      ["assignment", "x = 1"],
    ]);
    const v = editor(doc, 1);
    expect(await planAppendParameter(v, "c", "0")).toBe("place the caret on a function declaration");
  });
});

describe("appendParameterFallback", () => {
  const DOC = "def f(a, b):\n    return a + b\n";

  it("appends the parameter as one undo step", async () => {
    fnTree(DOC);
    const v = editor(DOC, 5);
    expect(await appendParameterFallback(v, "c", "0")).toBe(true);
    expect(v.state.doc.toString()).toBe("def f(a, b, c=0):\n    return a + b\n");
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("reports a refusal as handled, leaving the document alone", async () => {
    fnTree(DOC);
    const v = editor(DOC, 5);
    expect(await appendParameterFallback(v, "a", "0")).toBe(true);
    expect(v.state.doc.toString()).toBe(DOC);
    expect(showHint).toHaveBeenCalledWith(v, expect.stringContaining("already has a parameter 'a'"));
  });
});
