import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import type { IdentifierOccurrence, Locals, NodeAt, Range, SyntaxNode, WorkspaceEdit } from "@/bindings";

// --- a hand-built syntax tree over the test document -------------------------

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
  locals: null as unknown,
  identifiers: [] as unknown[],
  fileOccurrences: [] as unknown[],
}));

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
  locals: vi.fn(async () => H.locals as Locals),
  identifiers: vi.fn(async () => H.identifiers as IdentifierOccurrence[]),
  identifiersInFiles: vi.fn(async () => H.fileOccurrences as never[]),
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/p" } }) } }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { lspDoc } = await import("@/editor/lsp/lsp");
const { parameterItems, paramName, appendParameter, planChangeSignature } = await import("./changeSignature");

// --- helpers ------------------------------------------------------------------

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
  const end = doc.trimEnd().length;
  tree([
    ["module", doc.trimEnd()],
    ["function_definition", doc.slice(0, end)],
    ["parameters", doc.slice(doc.indexOf("("), doc.indexOf(")") + 1)],
  ]);
}

/** The items of a signature, failing the test when the list cannot be read. */
function items(signature: string) {
  const got = parameterItems(signature);
  if (typeof got === "string") throw new Error(got);
  return got;
}

/** The lone `edit` file of a plan, failing when the plan is a refusal. */
function planned(result: WorkspaceEdit | string): WorkspaceEdit {
  if (typeof result === "string") throw new Error(result);
  return result;
}

function fileOf(edit: WorkspaceEdit, path = "/p/a.py") {
  const file = edit.files.find((f) => f.kind === "edit" && f.path === path);
  if (!file || file.kind !== "edit") throw new Error(`no edit for ${path}`);
  return file;
}

beforeEach(() => {
  H.nodes = [];
  H.text = "";
  H.locals = null;
  H.identifiers = [];
  H.fileOccurrences = [];
});

afterEach(() => {
  view?.destroy();
  view = null;
  showHint.mockClear();
});

// ---------------------------------------------------------------------------

describe("parameterItems", () => {
  it("reads a plain list", () => {
    expect(items("def f(a, b)")).toEqual([
      { text: "a", from: 6, to: 7 },
      { text: "b", from: 9, to: 10 },
    ]);
  });

  it("reads an empty list", () => {
    expect(items("def f()")).toEqual([]);
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
    expect(appendParameter("def f(a, b)", "c", "0")).toEqual({ text: "def f(a, b, c=0)", parameter: "c=0" });
  });

  it("fills an empty list", () => {
    expect(appendParameter("def f()", "c", "0")).toEqual({ text: "def f(c=0)", parameter: "c=0" });
  });

  it("keeps the existing annotations", () => {
    expect(appendParameter("def f(a: int)", "b", "1")).toEqual({ text: "def f(a: int, b=1)", parameter: "b=1" });
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

describe("planChangeSignature — append", () => {
  const DOC = "def f(a, b):\n    return a + b\n";

  it("replaces the signature", async () => {
    fnTree(DOC);
    const v = editor(DOC, 5);
    const edit = planned(await planChangeSignature(v, { kind: "append", name: "c", def: "0" }, ["/p/a.py"]));
    const file = fileOf(edit);
    expect(file.edits).toHaveLength(1);
    expect(file.edits[0]!.new_text).toBe("def f(a, b, c=0)");
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
    expect(await planChangeSignature(view, { kind: "append", name: "c", def: "0" }, ["/p/a.java"])).toBe(
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
    expect(await planChangeSignature(v, { kind: "append", name: "c", def: "0" }, ["/p/a.py"])).toBe(
      "place the caret on a function declaration",
    );
  });
});

describe("planChangeSignature — rename", () => {
  const DOC = ["def f(a, b):", "    total = a + b", "    return total", "", "f(1, b=2)", ""].join("\n");

  /** The parameter `a`, its body use, and a positional + keyword call site. */
  function fixture(source = DOC) {
    fnTree(source);
    const paramAt = source.indexOf("(a") + 1;
    const useAt = source.indexOf("a + b");
    H.locals = {
      status: "local",
      symbol: {
        name: "a",
        kind: "parameter",
        definition: rangeOf(paramAt, paramAt + 1),
        scope: rangeOf(0, source.length),
        references: [rangeOf(useAt, useAt + 1)],
        certain: true,
        conflicts: [],
      },
    } satisfies Locals;
  }

  it("edits the signature, the body use and the keyword call site", async () => {
    fixture();
    H.fileOccurrences = [
      {
        path: "/p/a.py",
        occurrences: [
          {
            range: rangeOf(DOC.indexOf("(a") + 1, DOC.indexOf("(a") + 2),
            kind: "identifier",
            qualified: false,
            role: "parameter",
          },
          {
            range: rangeOf(DOC.indexOf("a + b"), DOC.indexOf("a + b") + 1),
            kind: "identifier",
            qualified: false,
            role: "other",
          },
          {
            range: rangeOf(DOC.indexOf("b=2"), DOC.indexOf("b=2") + 1),
            kind: "identifier",
            qualified: true,
            role: "keywordArgument",
          },
        ],
      },
    ];
    const v = editor(DOC, DOC.indexOf("(a") + 1);
    const edit = planned(await planChangeSignature(v, { kind: "rename", from: "a", to: "alpha" }, ["/p/a.py"]));
    const file = fileOf(edit);
    const texts = file.edits.map((e) => e.new_text);
    // The signature keeps `def f(…` and gains the new name; the body follows.
    expect(texts[0]).toBe("def f(alpha, b)");
    expect(texts).toContain("alpha");
    // Three edits: signature (replaced whole), body use, keyword label.
    expect(file.edits.length).toBe(3);
  });

  it("leaves a positional call site alone", async () => {
    const doc = ["def f(a):", "    return a", "", "f(1)", ""].join("\n");
    fnTree(doc);
    const paramAt = doc.indexOf("(a") + 1;
    H.locals = {
      status: "local",
      symbol: {
        name: "a",
        kind: "parameter",
        definition: rangeOf(paramAt, paramAt + 1),
        scope: rangeOf(0, doc.length),
        references: [rangeOf(doc.indexOf("return a") + 7, doc.indexOf("return a") + 8)],
        certain: true,
        conflicts: [],
      },
    } satisfies Locals;
    // The call site's `1` is not an occurrence of `a`, so nothing is listed for it.
    H.fileOccurrences = [
      {
        path: "/p/a.py",
        occurrences: [
          { range: rangeOf(paramAt, paramAt + 1), kind: "identifier", qualified: false, role: "parameter" },
          {
            range: rangeOf(doc.indexOf("return a") + 7, doc.indexOf("return a") + 8),
            kind: "identifier",
            qualified: false,
            role: "other",
          },
        ],
      },
    ];
    const v = editor(doc, paramAt);
    const edit = planned(await planChangeSignature(v, { kind: "rename", from: "a", to: "alpha" }, ["/p/a.py"]));
    // Signature + body use only; the positional call is untouched.
    expect(fileOf(edit).edits).toHaveLength(2);
  });

  it("refuses a parameter the declaration does not have", async () => {
    fixture();
    const v = editor(DOC, DOC.indexOf("(a") + 1);
    expect(await planChangeSignature(v, { kind: "rename", from: "zz", to: "alpha" }, ["/p/a.py"])).toBe(
      "the declaration has no parameter 'zz'",
    );
  });

  it("refuses a name already used in the function", async () => {
    fixture();
    H.identifiers = [
      {
        range: rangeOf(DOC.indexOf("total = a"), DOC.indexOf("total = a") + 5),
        kind: "identifier",
        qualified: false,
        role: "other",
      },
    ];
    const v = editor(DOC, DOC.indexOf("(a") + 1);
    expect(await planChangeSignature(v, { kind: "rename", from: "a", to: "total" }, ["/p/a.py"])).toBe(
      "'total' is already used in this function",
    );
  });

  it("refuses a name an existing parameter already has", async () => {
    fixture();
    const v = editor(DOC, DOC.indexOf("(a") + 1);
    expect(await planChangeSignature(v, { kind: "rename", from: "a", to: "b" }, ["/p/a.py"])).toBe(
      "the declaration already has a parameter 'b'",
    );
  });

  it("refuses a shadowed parameter", async () => {
    fixture();
    H.locals = {
      status: "local",
      symbol: {
        name: "a",
        kind: "parameter",
        definition: rangeOf(DOC.indexOf("(a") + 1, DOC.indexOf("(a") + 2),
        scope: rangeOf(0, DOC.length),
        references: [],
        certain: false,
        conflicts: [],
      },
    } satisfies Locals;
    const v = editor(DOC, DOC.indexOf("(a") + 1);
    expect(await planChangeSignature(v, { kind: "rename", from: "a", to: "alpha" }, ["/p/a.py"])).toBe(
      "'a' is shadowed inside the body",
    );
  });
});
