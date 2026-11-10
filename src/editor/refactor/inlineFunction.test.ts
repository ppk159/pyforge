import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { IdentifierOccurrence, NodeAt, OutlineItem, Range, SyntaxNode } from "@/bindings";

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
  outline: [] as OutlineItem[],
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
  identifiers: vi.fn(async (_doc: number, name: string): Promise<IdentifierOccurrence[]> => {
    const out: IdentifierOccurrence[] = [];
    for (const m of H.text.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))) {
      out.push({
        range: rangeOf(m.index!, m.index! + name.length),
        kind: "identifier",
        // `obj.x` names a member, which is never a parameter reference.
        qualified: H.text[m.index! - 1] === ".",
        role: "other",
      });
    }
    return out;
  }),
  locals: vi.fn(async () => ({ status: "noIdentifier" as const })),
  localsInRange: vi.fn(async () => ({ names: [], occurrences: 0, truncated: false })),
  expressionAt: vi.fn(async () => {
    throw new Error("unused");
  }),
  syntaxErrors: vi.fn(async () => ({ errors: [], truncated: false })),
  structuralRanges: vi.fn(async () => {
    throw new Error("unused");
  }),
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/p" } }) } }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    call: async <T>(p: Promise<{ status: string; data?: T }>) => {
      const r = await p;
      if (r.status !== "ok") throw new Error("ipc error");
      return r.data as T;
    },
    commands: { ...actual.commands, docOutline: async () => ({ status: "ok", data: H.outline }) },
  };
});

const { lspDoc } = await import("@/editor/lsp/lsp");
const {
  planInlineFunction,
  inlineFunctionFallback,
  isCallUnderCaret,
  parametersOf,
  argumentsOf,
  parseParam,
  topLevelEquals,
  splitTopLevel,
  isAtomText,
} = await import("./inlineFunction");
import type { Param } from "./inlineFunction";

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

function outlineOf(...names: string[]) {
  H.outline = names.map((name) => {
    const at = H.text.indexOf(`def ${name}`);
    // The declaration ends at the last body line: the next line that is non-blank
    // and starts in column 0 is a new top-level statement. This mirrors what
    // `docOutline` reports (the function's own extent, not the rest of the file).
    const lines = H.text.split("\n");
    const startLine = H.text.slice(0, at).split("\n").length - 1;
    let endLine = startLine;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() && !/^\s/.test(line)) break;
      if (line.trim()) endLine = i;
    }
    let end = 0;
    for (let i = 0; i <= endLine; i++) end += (lines[i] ?? "").length + 1;
    end -= 1;
    return {
      name,
      detail: null,
      kind: "function",
      range: rangeOf(at, end),
      selection_range: rangeOf(at + 4, at + 4 + name.length),
      children: [],
      visibility: null,
    } as unknown as OutlineItem;
  });
}

beforeEach(() => {
  H.nodes = [];
  H.text = "";
  H.outline = [];
});

afterEach(() => {
  view?.destroy();
  view = null;
  showHint.mockClear();
});

// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("finds the assigning `=` only", () => {
    expect(topLevelEquals("a=1")).toBe(1);
    expect(topLevelEquals("a==1")).toBe(-1);
    expect(topLevelEquals("a>=1")).toBe(-1);
    expect(topLevelEquals("f(x=1)")).toBe(-1);
    expect(topLevelEquals("a: int = 1")).toBe(7);
  });

  it("splits on top-level commas only", () => {
    expect(splitTopLevel("a, b=2, c")).toEqual(["a", "b=2", "c"]);
    expect(splitTopLevel("f(a, b), c")).toEqual(["f(a, b)", "c"]);
    expect(splitTopLevel("  ")).toEqual([]);
  });

  it("parses the parameter shapes Python allows", () => {
    expect(parseParam("a")).toEqual({ name: "a", default: null, splat: false });
    expect(parseParam("a: int")).toEqual({ name: "a", default: null, splat: false });
    expect(parseParam("b=2")).toEqual({ name: "b", default: "2", splat: false });
    expect(parseParam("b: int = 2")).toEqual({ name: "b", default: "2", splat: false });
    expect(parseParam("*args")).toEqual({ name: "args", default: null, splat: true });
    expect(parseParam("**kw")).toEqual({ name: "kw", default: null, splat: true });
  });

  it("reads a parameter list", () => {
    expect(parametersOf("def f(a, b=2):")).toEqual([
      { name: "a", default: null, splat: false },
      { name: "b", default: "2", splat: false },
    ]);
    expect(parametersOf("def f():")).toEqual([]);
    expect(parametersOf("def f(a, *rest):")).toBe("the declaration takes *args or **kwargs");
  });

  it("matches arguments to parameters", () => {
    const params = parametersOf("def f(a, b):") as Param[];
    expect(argumentsOf("f(1, 2)", params)).toEqual([
      { name: "a", text: "1" },
      { name: "b", text: "2" },
    ]);
    expect(argumentsOf("f(b=2, a=1)", params)).toEqual([
      { name: "b", text: "2" },
      { name: "a", text: "1" },
    ]);
    expect(argumentsOf("f(1, 2, 3)", params)).toBe("the call passes more arguments than the declaration takes");
    expect(argumentsOf("f(*xs)", params)).toBe("the call unpacks its arguments");
  });

  it("knows what can stand as an operand", () => {
    expect(isAtomText("x")).toBe(true);
    expect(isAtomText("obj.attr")).toBe(true);
    expect(isAtomText("42")).toBe(true);
    expect(isAtomText("f(x)")).toBe(true);
    expect(isAtomText("[1, 2]")).toBe(true);
    expect(isAtomText("a + 1")).toBe(false);
    expect(isAtomText("x if c else y")).toBe(false);
  });
});

describe("planInlineFunction", () => {
  const SRC = ["def double(x):", "    return x * 2", "", "y = double(a + 1)", ""].join("\n");
  const CALL = SRC.indexOf("double(a + 1)");

  function fixture() {
    H.text = SRC;
    outlineOf("double");
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", "def double(x):\n    return x * 2"],
      ["parameters", "(x)"],
      ["identifier", "x", 0],
      ["block", "    return x * 2", 0, "body"],
      ["return_statement", "return x * 2"],
      ["binary_operator", "x * 2"],
      ["assignment", "y = double(a + 1)"],
      ["call", "double(a + 1)", 0, "right"],
      ["identifier", "double", 0, "function"],
      ["argument_list", "(a + 1)", 0, "arguments"],
    ]);
  }

  it("replaces a call by the single returned expression", async () => {
    fixture();
    const v = editor(SRC, CALL + 2);
    const plan = await planInlineFunction(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.callee).toBe("double");
    expect(plan.text).toBe("(a + 1) * 2");
    // The call is the whole right-hand side, so nothing can re-associate it.
    expect(plan.wrap).toBe(false);
  });

  it("binds a default the call leaves out", async () => {
    const src = ["def shift(x, by=1):", "    return x + by", "", "y = shift(a)", ""].join("\n");
    H.text = src;
    outlineOf("shift");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def shift(x, by=1):\n    return x + by"],
      ["block", "    return x + by", 0, "body"],
      ["return_statement", "return x + by"],
      ["binary_operator", "x + by"],
      ["call", "shift(a)", 0, "right"],
      ["identifier", "shift", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    const v = editor(src, src.indexOf("shift(a)") + 1);
    const plan = await planInlineFunction(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe("a + 1");
  });

  it("does not wrap an atom argument", async () => {
    const src = ["def double(x):", "    return x * 2", "", "y = double(a)", ""].join("\n");
    H.text = src;
    outlineOf("double");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def double(x):\n    return x * 2"],
      ["block", "    return x * 2", 0, "body"],
      ["return_statement", "return x * 2"],
      ["binary_operator", "x * 2"],
      ["call", "double(a)", 0, "right"],
      ["identifier", "double", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    const v = editor(src, src.indexOf("double(a)") + 1);
    const plan = await planInlineFunction(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.text).toBe("a * 2");
    expect(plan.wrap).toBe(false);
  });

  it("refuses a body with statements before its return", async () => {
    const src = ["def f(x):", "    total = x + 1", "    return total", "", "y = f(a)", ""].join("\n");
    H.text = src;
    outlineOf("f");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def f(x):\n    total = x + 1\n    return total"],
      ["call", "f(a)", 0, "right"],
      ["identifier", "f", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    const v = editor(src, src.indexOf("f(a)") + 1);
    expect(await planInlineFunction(v)).toBe("the declaration does more than return an expression");
  });

  it("refuses a generator, a coroutine and a decorated function", async () => {
    const gen = ["def f(x):", "    yield x", "", "y = f(a)", ""].join("\n");
    H.text = gen;
    outlineOf("f");
    tree([
      ["module", gen.trimEnd()],
      ["function_definition", "def f(x):\n    yield x"],
      ["call", "f(a)", 0, "right"],
      ["identifier", "f", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    expect(await planInlineFunction(editor(gen, gen.indexOf("f(a)") + 1))).toBe("the declaration is a generator");

    const coro = ["async def f(x):", "    return x", "", "y = f(a)", ""].join("\n");
    H.text = coro;
    outlineOf("f");
    tree([
      ["module", coro.trimEnd()],
      ["function_definition", "async def f(x):\n    return x"],
      ["call", "f(a)", 0, "right"],
      ["identifier", "f", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    expect(await planInlineFunction(editor(coro, coro.indexOf("f(a)") + 1))).toBe("the declaration is a coroutine");

    const dec = ["@cache", "def f(x):", "    return x", "", "y = f(a)", ""].join("\n");
    H.text = dec;
    outlineOf("f");
    tree([
      ["module", dec.trimEnd()],
      ["function_definition", "@cache\ndef f(x):\n    return x"],
      ["call", "f(a)", 0, "right"],
      ["identifier", "f", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    expect(await planInlineFunction(editor(dec, dec.indexOf("f(a)") + 1))).toBe("the declaration is decorated");
  });

  it("refuses a call whose declaration is not in this file", async () => {
    const src = "y = helper(a)\n";
    H.text = src;
    H.outline = [];
    tree([
      ["module", src.trimEnd()],
      ["call", "helper(a)", 0, "right"],
      ["identifier", "helper", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    const v = editor(src, 6);
    expect(await planInlineFunction(v)).toBe("'helper' is not declared in this file");
  });

  it("refuses a call inside its own declaration", async () => {
    const src = ["def f(x):", "    return f(x)", ""].join("\n");
    H.text = src;
    outlineOf("f");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def f(x):\n    return f(x)"],
      ["block", "    return f(x)", 0, "body"],
      ["return_statement", "return f(x)"],
      ["call", "f(x)", 0, "right"],
      ["identifier", "f", 0, "function"],
      ["argument_list", "(x)", 0, "arguments"],
    ]);
    const v = editor(src, src.indexOf("f(x)") + 1);
    expect(await planInlineFunction(v)).toBe("the call is inside its own declaration");
  });

  it("refuses a language without a syntax-only implementation", async () => {
    H.text = "x = f(1);";
    view = new EditorView({
      state: EditorState.create({
        doc: H.text,
        selection: { anchor: 5 },
        extensions: [
          history(),
          lspDoc.of({ doc: 1, path: "/p/a.java", language: "java", uiMode: null, readOnly: false }),
        ],
      }),
    });
    expect(await planInlineFunction(view)).toBe("Inline Method needs the language server for this language");
  });

  it("refuses when the caret is not on a call", async () => {
    const src = "y = a + 1\n";
    H.text = src;
    tree([
      ["module", src.trimEnd()],
      ["binary_operator", "a + 1"],
    ]);
    const v = editor(src, 5);
    expect(await planInlineFunction(v)).toBe("place the caret on a call");
    expect(await isCallUnderCaret(v)).toBe(false);
  });
});

describe("isCallUnderCaret", () => {
  it("is true on the callee and inside the arguments", async () => {
    const src = ["def double(x):", "    return x * 2", "", "y = double(a + 1)", ""].join("\n");
    H.text = src;
    outlineOf("double");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def double(x):\n    return x * 2"],
      ["call", "double(a + 1)", 0, "right"],
      ["identifier", "double", 0, "function"],
      ["argument_list", "(a + 1)", 0, "arguments"],
    ]);
    for (const at of [2, 10]) {
      const v = editor(src, src.indexOf("double(a + 1)") + at);
      expect(await isCallUnderCaret(v)).toBe(true);
      v.destroy();
    }
    view = null;
  });
});

describe("inlineFunctionFallback", () => {
  const SRC = ["def double(x):", "    return x * 2", "", "y = double(a + 1)", ""].join("\n");
  const CALL = SRC.indexOf("double(a + 1)");

  function fixture() {
    H.text = SRC;
    outlineOf("double");
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", "def double(x):\n    return x * 2"],
      ["block", "    return x * 2", 0, "body"],
      ["return_statement", "return x * 2"],
      ["binary_operator", "x * 2"],
      ["assignment", "y = double(a + 1)"],
      ["call", "double(a + 1)", 0, "right"],
      ["identifier", "double", 0, "function"],
      ["argument_list", "(a + 1)", 0, "arguments"],
    ]);
  }

  it("replaces the call as one undo step", async () => {
    fixture();
    const v = editor(SRC, CALL + 2);
    expect(await inlineFunctionFallback(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(["def double(x):", "    return x * 2", "", "y = (a + 1) * 2", ""].join("\n"));
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(SRC);
  });

  it("keeps an atom expression bare", async () => {
    const src = ["def same(x):", "    return x", "", "y = same(v)", ""].join("\n");
    H.text = src;
    outlineOf("same");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def same(x):\n    return x"],
      ["block", "    return x", 0, "body"],
      ["return_statement", "return x"],
      ["identifier", "x", 1],
      ["call", "same(v)", 0, "right"],
      ["identifier", "same", 0, "function"],
      ["argument_list", "(v)", 0, "arguments"],
    ]);
    const v = editor(src, src.indexOf("same(v)") + 1);
    expect(await inlineFunctionFallback(v)).toBe(true);
    expect(v.state.doc.toString()).toContain("y = v");
  });

  it("reports a refusal as handled, leaving the document alone", async () => {
    const src = ["def f(x):", "    total = x", "    return total", "", "y = f(a)", ""].join("\n");
    H.text = src;
    outlineOf("f");
    tree([
      ["module", src.trimEnd()],
      ["function_definition", "def f(x):\n    total = x\n    return total"],
      ["call", "f(a)", 0, "right"],
      ["identifier", "f", 0, "function"],
      ["argument_list", "(a)", 0, "arguments"],
    ]);
    const v = editor(src, src.indexOf("f(a)") + 1);
    expect(await inlineFunctionFallback(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(src);
    expect(showHint).toHaveBeenCalledWith(v, expect.stringContaining("does more than return an expression"));
  });
});
