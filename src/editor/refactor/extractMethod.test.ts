import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { ExpressionAt, Locals, NodeAt, Range, SyntaxErrors, SyntaxNode } from "@/bindings";

// --- a hand-built syntax tree over the test document -------------------------
//
// Everything the mocked `structure` service reads lives in `H`, hoisted above
// the `vi.mock` calls so the factory (hoisted too) can reach it.

interface FakeNode {
  kind: string;
  from: number;
  to: number;
  field: string | null;
  parent: FakeNode | null;
  /** The parser reported an error at or under this node. */
  error?: boolean;
}

const H = vi.hoisted(() => ({
  text: "",
  nodes: [] as FakeNode[],
  localAt: new Map<number, unknown>(),
  /** Offsets the real query treats as a comment or string (`noIdentifier`). */
  docOnly: new Set<number>(),
  blockSpan: null as { from: number; to: number } | null,
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
    error: !!n.error,
    missing: false,
    hasError: !!n.error,
  };
}

/** Nodes outer → inner: `[kind, needle, nth?, field?]`. */
function tree(specs: Array<[string, string, number?, string?]>) {
  H.nodes = [];
  for (const [kind, needle, nth = 0, field = null] of specs) {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = H.text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`no ${needle}`);
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
  expressionAt: vi.fn(async (_doc: number, range: Range): Promise<ExpressionAt> => {
    const at = offOf(range.start);
    const sp = H.blockSpan;
    const block = sp ? H.nodes.find((n) => n.kind === "block" && n.from === sp.from && n.to === sp.to) : undefined;
    // The statement is the block's first direct child reaching past the caret
    // (the selection starts at the line start, before the statement itself).
    const stmt = H.nodes.filter((n) => n.parent === block && n.to > at).shift();
    return {
      expression: null,
      exact: false,
      candidates: [],
      statement: stmt ? toSyntax(stmt) : null,
      block: block ? toSyntax(block) : null,
      functionBoundary: null,
      hasError: false,
    };
  }),
  nodeAt: vi.fn(async (_doc: number, range: Range) => nodeAt(range)),
  syntaxErrors: vi.fn(async (): Promise<SyntaxErrors> => ({ errors: [], truncated: false })),
  identifiers: vi.fn(async (_doc: number, name: string) => {
    const out: { range: Range; kind: string; qualified: boolean }[] = [];
    for (const m of H.text.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))) {
      out.push({
        range: rangeOf(m.index!, m.index! + name.length),
        kind: "identifier",
        qualified: H.text[m.index! - 1] === ".",
      });
    }
    return out;
  }),
  locals: vi.fn(async (_doc: number, pos: { line: number; col: number }) => {
    const off = Text.of(H.text.split("\n")).line(pos.line + 1).from + pos.col;
    const exact = H.localAt.get(off);
    if (exact) return exact as Locals;
    // Any occurrence of a known symbol resolves to that symbol.
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(H.text.slice(off))?.[0];
    if (name) {
      const at = H.text.indexOf(name);
      const known = H.localAt.get(at);
      if (known && /^[A-Za-z_][A-Za-z0-9_]*/.exec(H.text.slice(at))?.[0] === name) return known as Locals;
    }
    // What the real query answers for a word it cannot resolve. `noIdentifier`
    // is reserved for comments and strings (see `H.docOnly`).
    if (H.docOnly.has(off)) return { status: "noIdentifier" as const };
    const word = name ?? "";
    if (!word) return { status: "noIdentifier" as const };
    return { status: "notLocal", name: word, range: rangeOf(off, off + word.length), reason: "unresolved" as const };
  }),
  /**
   * The batch call: one request answering every name in the selection, mirroring
   * `locals_in_range`. It ranks the same way (local > unresolved > member > none)
   * and drops names whose every occurrence is in a comment or string.
   */
  localsInRange: vi.fn(async (_doc: number, from: { line: number; col: number }, to: { line: number; col: number }) => {
    const lines = H.text.split("\n");
    const offsetOf = (p: { line: number; col: number }) => {
      let off = 0;
      for (let i = 0; i < p.line; i++) off += (lines[i] ?? "").length + 1;
      return off + p.col;
    };
    const a = offsetOf(from);
    const b = offsetOf(to);
    const region = H.text.slice(a, b);
    const RANK = { local: 3, unresolved: 2, member: 1, none: 0 } as const;
    const best = new Map<string, { rank: number; locals: Locals; at: number }>();
    for (const [i, m] of [...region.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].entries()) {
      const name = m[0]!;
      const at = a + (m.index ?? 0);
      const answer = (await structureMock.locals(_doc, posOf(at))) as Locals;
      const rank =
        answer.status === "local"
          ? RANK.local
          : answer.status === "noIdentifier"
            ? RANK.none
            : answer.reason === "member"
              ? RANK.member
              : RANK.unresolved;
      const previous = best.get(name);
      if (!previous || rank > previous.rank) best.set(name, { rank, locals: answer, at });
      void i;
    }
    const names = [...best]
      .filter(([, v]) => v.rank > 0)
      .map(([name, v]) => ({ name, at: posOf(v.at), locals: v.locals }));
    return { names, occurrences: region.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.length ?? 0, truncated: false };
  }),
  structuralRanges: vi.fn(async () => {
    throw new Error("unused");
  }),
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/p" } }) } }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { useLspPopup } = await import("@/editor/lsp/popupStore");
const { lspDoc } = await import("@/editor/lsp/lsp");
const { declarationText, callText, planExtract, wholeStatements, extractMethodFallback } =
  await import("./extractMethod");

// --- editor -------------------------------------------------------------------

let view: EditorView | null = null;

function editor(doc: string, sel: { anchor: number; head?: number }) {
  H.text = doc;
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: sel,
      extensions: [
        history(),
        lspDoc.of({ doc: 1, path: "/p/a.py", language: "python", uiMode: null, readOnly: false }),
      ],
    }),
  });
  return view;
}

const popup = () => useLspPopup.getState().popup;

/** Declares a local: defined at `def`, listed as referenced at each `ref`. */
function local(name: string, def: { from: number; to: number }, refs: Array<{ from: number; to: number }>) {
  const answer: Locals = {
    status: "local",
    symbol: {
      name,
      kind: "var",
      definition: rangeOf(def.from, def.to),
      scope: rangeOf(0, H.text.length),
      references: refs.map((r) => rangeOf(r.from, r.to)),
      certain: true,
      conflicts: [],
    },
  };
  H.localAt.set(def.from, answer);
  for (const r of refs) H.localAt.set(r.from, answer);
}

beforeEach(() => {
  H.localAt = new Map();
  H.docOnly = new Set();
  H.blockSpan = null;
  H.nodes = [];
  H.text = "";
});

afterEach(() => {
  view?.destroy();
  view = null;
  useLspPopup.setState({ popup: null });
  showHint.mockClear();
});

// ---------------------------------------------------------------------------

describe("wholeStatements", () => {
  const doc = (s: string) => Text.of(s.split("\n"));

  it("accepts whole lines at one level", () => {
    const src = "def f():\n    a = 1\n    b = 2\n    return a\n";
    const from = src.indexOf("    a = 1");
    const to = src.indexOf("    return");
    // The selection ends at the start of the following line, so the run of
    // statements ends at the previous line's end.
    expect(wholeStatements(doc(src), from, to)).toEqual({ from, to: to - 1, indent: "    " });
  });

  it("refuses a partially selected first line", () => {
    const src = "def f():\n    a = 1\n    return a\n";
    const from = src.indexOf("a = 1") + 1;
    expect(wholeStatements(doc(src), from, src.indexOf("    return"))).toBe(
      "the selection must start at a statement boundary",
    );
  });

  it("refuses a selection that ends with a block head", () => {
    const src = "def f():\n    if x:\n        a = 1\n    return a\n";
    const from = src.indexOf("    if x:");
    const to = src.indexOf("        a = 1");
    expect(wholeStatements(doc(src), from, to)).toBe("the selection ends with the head of a block");
  });

  it("refuses return and global", () => {
    const r = (src: string) => {
      const start = src.indexOf("\n") + 1;
      return wholeStatements(doc(src), start, src.indexOf("\n", start));
    };
    expect(wholeStatements(doc("def f():\n    a = 1\n    return a\n"), 12, 36)).toBe(
      "the selection contains return, yield or await",
    );
    expect(r("def f():\n    a = 1 ; global g\n")).toBe("the selection declares a global or nonlocal name");
  });

  it("accepts a match statement: the scope query resolves its patterns", () => {
    // `case [a, b]` binds names the query now reports, so a match block is a
    // normal run of statements.
    const m = [
      "def f(v):",
      "    match v:",
      "        case [a, b]:",
      "            out.append(a)",
      "    return out",
      "",
    ].join("\n");
    const from = m.indexOf("    match v:");
    const to = m.indexOf("    return out");
    const got = wholeStatements(doc(m), from, to);
    expect(typeof got).not.toBe("string");
  });

  it("refuses a starred assignment target but not a starred call", () => {
    const src = "def f(pair):\n    first, *rest = pair\n    return first\n";
    const from = src.indexOf("    first, *rest");
    expect(wholeStatements(doc(src), from, src.indexOf("    return"))).toBe(
      "the selection uses a starred assignment target ('*rest'), which the syntax service does not resolve",
    );
    // A starred call is fine: nothing precedes its `=`.
    const call = "def f(args):\n    out = g(*args)\n    return out\n";
    const cf = call.indexOf("    out = g");
    expect(typeof wholeStatements(doc(call), cf, call.indexOf("    return"))).not.toBe("string");
  });

  it("accepts a variable named `match` (it is a soft keyword)", () => {
    const src = "def f(re, s):\n    match = re.search(s)\n    return match\n";
    const from = src.indexOf("    match =");
    expect(typeof wholeStatements(doc(src), from, src.indexOf("    return"))).not.toBe("string");
  });

  it("refuses module-level statements (no indent)", () => {
    const src = "a = 1\nb = 2\n";
    expect(wholeStatements(doc(src), 0, src.length)).toBe("the selection must be inside a function body");
  });

  it("refuses a partially selected last line", () => {
    const src = "def f():\n    a = 1\n    b = 2\n    return a\n";
    const from = src.indexOf("    a = 1");
    // Stop in the middle of `b = 2`.
    expect(wholeStatements(doc(src), from, src.indexOf("    b = 2") + 5)).toBe(
      "the selection must end at a statement boundary",
    );
  });

  it("refuses a blank selection", () => {
    const src = "def f():\n\n    return 1\n";
    expect(wholeStatements(doc(src), src.indexOf("\n") + 1, src.indexOf("\n") + 2)).toBe(
      "the selection has no statements",
    );
  });

  it("refuses a selection that steps out of its indentation", () => {
    const src = "def f():\n    if x:\n        a = 1\n    b = 2\n    return a\n";
    // Starts inside the `if` body, then includes the shallower statement after it.
    const from = src.indexOf("        a = 1");
    const to = src.indexOf("    return");
    expect(wholeStatements(doc(src), from, to)).toBe("the selection is not one run of statements at the same level");
  });

  it("accepts a nested block inside the selection", () => {
    const src = "def f():\n    if x:\n        a = 1\n    return a\n";
    const from = src.indexOf("    if x:");
    const to = src.indexOf("    return");
    expect(wholeStatements(doc(src), from, to)).toEqual({ from, to: to - 1, indent: "    " });
  });
});

describe("declarationText / callText", () => {
  const plan = {
    from: 0,
    to: 0,
    body: "    total *= 0.9\n    total *= 1.05",
    bodyIndent: "    ",
    defIndent: "",
    bodyIndentInner: "    ",
    insertAt: 0,
    params: ["order", "total"],
    outputs: ["total"],
  };

  it("re-indents the body and appends the return", () => {
    expect(declarationText(plan, "apply_discounts")).toBe(
      "def apply_discounts(order, total):\n    total *= 0.9\n    total *= 1.05\n    return total",
    );
  });

  it("writes the call with the parameters in order", () => {
    expect(callText(plan, "apply_discounts")).toBe("    total = apply_discounts(order, total)");
  });

  it("omits the return and the assignment for a void extraction", () => {
    const voided = { ...plan, outputs: [], params: [] };
    expect(declarationText(voided, "log_it")).toBe("def log_it():\n    total *= 0.9\n    total *= 1.05");
    expect(callText(voided, "log_it")).toBe("    log_it()");
  });

  it("nests the body one level deeper inside a function", () => {
    const nested = { ...plan, defIndent: "    ", bodyIndentInner: "        " };
    expect(declarationText(nested, "helper")).toBe(
      "    def helper(order, total):\n        total *= 0.9\n        total *= 1.05\n        return total",
    );
  });
});

const SRC = [
  "def process(order):",
  "    total = 0",
  "    if order.discount:",
  "        rate = 0.9",
  "    total *= rate",
  "    print(total)",
  "    return total",
  "",
].join("\n");

const BODY_FROM = SRC.indexOf("    if order.discount:");
const BODY_TO = SRC.indexOf("    total *= rate");

/** The tree and the `locals` answers the fixtures below share. */
function fixture() {
  H.text = SRC;
  H.blockSpan = { from: BODY_FROM, to: BODY_TO };
  tree([
    ["module", SRC.trimEnd()],
    ["function_definition", SRC.trimEnd()],
    ["block", SRC.slice(BODY_FROM, BODY_TO), 0, "body"],
    ["if_statement", "    if order.discount:\n        rate = 0.9"],
    ["expression_statement", "        rate = 0.9"],
  ]);
  // `rate` is declared inside the selection and read after it: the output.
  const rateDecl = SRC.indexOf("        rate = 0.9") + 8;
  local("rate", { from: rateDecl, to: rateDecl + 4 }, [
    { from: SRC.indexOf("total *= rate") + 9, to: SRC.indexOf("total *= rate") + 13 },
  ]);
  // `order` is a parameter: declared outside, read inside.
  local("order", { from: SRC.indexOf("(order)") + 1, to: SRC.indexOf("(order)") + 6 }, [
    { from: SRC.indexOf("order.discount"), to: SRC.indexOf("order.discount") + 5 },
  ]);
}

describe("planExtract", () => {
  it("collects the free variables as parameters, in first-use order", async () => {
    fixture();
    const v = editor(SRC, { anchor: BODY_FROM, head: BODY_TO });
    const plan = await planExtract(v);
    expect(typeof plan).not.toBe("string");
    if (typeof plan === "string") return;
    expect(plan.params).toEqual(["order"]);
    expect(plan.outputs).toEqual(["rate"]);
    expect(plan.bodyIndent).toBe("    ");
    expect(plan.defIndent).toBe("");
    expect(plan.insertAt).toBe(SRC.indexOf("    return total") + "    return total".length);
  });

  it("keeps `self` as a parameter (it is a keyword in the shared list, an implicit parameter in Python)", async () => {
    const src = [
      "class A:",
      "    def add(self, title):",
      "        task = make(title)",
      "        self._tasks.append(task)",
      "        return task",
      "",
    ].join("\n");
    const from = src.indexOf("        task = make");
    const to = src.indexOf("        return task");
    H.text = src;
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["class_definition", src.trimEnd()],
      [
        "block",
        "    def add(self, title):\n        task = make(title)\n        self._tasks.append(task)\n        return task",
        0,
        "body",
      ],
      [
        "function_definition",
        "    def add(self, title):\n        task = make(title)\n        self._tasks.append(task)\n        return task",
      ],
      ["block", src.slice(from, to), 0, "body"],
      ["assignment", "task = make(title)"],
    ]);
    const selfParam = src.indexOf("(self") + 1;
    local("self", { from: selfParam, to: selfParam + 4 }, [
      { from: src.indexOf("self._tasks"), to: src.indexOf("self._tasks") + 4 },
    ]);
    const titleParam = src.indexOf("title)") - 5;
    local("title", { from: titleParam, to: titleParam + 5 }, [
      { from: src.indexOf("make(title)") + 5, to: src.indexOf("make(title)") + 10 },
    ]);
    const taskDecl = src.indexOf("task = make");
    local("task", { from: taskDecl, to: taskDecl + 4 }, [
      { from: src.indexOf("append(task)") + 7, to: src.indexOf("append(task)") + 11 },
      { from: src.indexOf("return task") + 7, to: src.indexOf("return task") + 11 },
    ]);
    const v = editor(src, { anchor: from, head: to });
    const plan = await planExtract(v);
    expect(typeof plan).not.toBe("string");
    if (typeof plan === "string") return;
    expect(plan.params).toEqual(["title", "self"]);
    expect(plan.outputs).toEqual(["task"]);
    expect(plan.defIndent).toBe("    ");
  });

  it("resolves a name whose first occurrence is a keyword-argument label", async () => {
    const src = [
      "def make(title, tags):",
      "    task = Task(title.strip(), tags=set(tags))",
      "    return task",
      "",
    ].join("\n");
    const from = src.indexOf("    task = Task");
    const to = src.indexOf("    return task");
    H.text = src;
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.slice(from, to), 0, "body"],
      ["assignment", "task = Task(title.strip(), tags=set(tags))"],
    ]);
    const tagsParam = src.indexOf("tags)") - 4;
    local("tags", { from: tagsParam, to: tagsParam + 4 }, [
      { from: src.indexOf("set(tags)") + 4, to: src.indexOf("set(tags)") + 8 },
    ]);
    const titleParam = src.indexOf("(title,") + 1;
    local("title", { from: titleParam, to: titleParam + 5 }, [
      { from: src.indexOf("Task(title") + 5, to: src.indexOf("Task(title") + 10 },
    ]);
    const taskDecl2 = src.indexOf("task = Task");
    local("task", { from: taskDecl2, to: taskDecl2 + 4 }, [
      { from: src.indexOf("return task") + 7, to: src.indexOf("return task") + 11 },
    ]);
    const v = editor(src, { anchor: from, head: to });
    const plan = await planExtract(v);
    expect(typeof plan).not.toBe("string");
    if (typeof plan === "string") return;
    expect(plan.params).toEqual(["title", "tags"]);
  });

  it("ignores a parameter name that only appears in a docstring", async () => {
    // Measured on CPython's `_pyio.FileIO.read`: the selection is a docstring
    // that mentions `size`, which is a parameter. All occurrences answer
    // `noIdentifier`, so it is not a variable of the selection and must not be
    // refused — the earlier code refused it as "cannot resolve".
    const src = [
      "def read(self, size=None):",
      '    """Read size bytes. If size is negative, read until EOF."""',
      "    return self.raw.read(size)",
      "",
    ].join("\n");
    const from = src.indexOf('    """');
    const to = src.indexOf("    return self.raw");
    H.text = src;
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.slice(from, to), 0, "body"],
      ["expression_statement", '    """Read size bytes. If size is negative, read until EOF."""'],
      ["string", '"""Read size bytes. If size is negative, read until EOF."""'],
    ]);
    // Every `size` in the docstring is a word in a string, as the real query says.
    for (let i = -1; (i = src.indexOf("size", i + 1)) >= 0;) {
      if (i > to) break;
      H.docOnly.add(i);
    }
    const v = editor(src, { anchor: from, head: to });
    const plan = await planExtract(v);
    // Nothing to extract from a bare string statement, but not because of `size`.
    expect(plan).not.toBe("'size' is local to this function but the syntax service cannot resolve it here");
  });

  it("refuses a name the scope query misses when the enclosing function binds it", async () => {
    // `tags` is a parameter but `locals` cannot resolve it: passing it would be
    // wrong to skip, because the new method would read an undefined name.
    const src = ["def make(title, *tags: str):", "    task = Task(title, tags=set(tags))", "    return task", ""].join(
      "\n",
    );
    const from = src.indexOf("    task = Task");
    const to = src.indexOf("    return task");
    H.text = src;
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.slice(from, to), 0, "body"],
      ["assignment", "task = Task(title, tags=set(tags))"],
    ]);
    // `locals` answers `unresolved` for `tags` (the gap the POC probe found);
    // the mock prefers a registered symbol, so leave `tags` unregistered.
    const titleParam2 = src.indexOf("(title") + 1;
    local("title", { from: titleParam2, to: titleParam2 + 5 }, [
      { from: src.indexOf("Task(title") + 5, to: src.indexOf("Task(title") + 10 },
    ]);
    const taskDecl3 = src.indexOf("task = Task");
    local("task", { from: taskDecl3, to: taskDecl3 + 4 }, [
      { from: src.indexOf("return task") + 7, to: src.indexOf("return task") + 11 },
    ]);
    const v = editor(src, { anchor: from, head: to });
    expect(await planExtract(v)).toBe("'tags' is local to this function but the syntax service cannot resolve it here");
  });

  it("refuses when the selection assigns a parameter", async () => {
    // `order` is declared outside the selection (a parameter) and written inside.
    const src = "def process(order):\n    order = normalize(order)\n    print(order)\n";
    H.text = src;
    const from = src.indexOf("    order = normalize");
    const to = src.indexOf("    print(order)");
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.slice(from, to), 0, "body"],
      ["assignment", "order = normalize(order)"],
      ["identifier", "order", 1, "left"],
    ]);
    const param = src.indexOf("(order)") + 1;
    local("order", { from: param, to: param + 5 }, [
      { from: src.indexOf("order ="), to: src.indexOf("order =") + 5 },
      { from: src.indexOf("normalize(order)") + 10, to: src.indexOf("normalize(order)") + 15 },
      { from: src.indexOf("print(order)") + 6, to: src.indexOf("print(order)") + 11 },
    ]);
    const v = editor(src, { anchor: from, head: to });
    expect(await planExtract(v)).toBe("the selection assigns 'order', which is declared outside it");
  });

  it("refuses a selection that starts inside a construct (an except clause)", async () => {
    // `statement` is the statement inside the clause, not the clause itself, so
    // the selection starts before it: extracting would take half the clause.
    const src = [
      "def parse(p):",
      "    try:",
      "        return load(p)",
      "    except ValueError as e:",
      "        log(e)",
      "",
    ].join("\n");
    H.text = src;
    const clauseFrom = src.indexOf("        log(e)");
    const clauseSpan = src.slice(clauseFrom);
    H.blockSpan = { from: clauseFrom, to: clauseFrom + clauseSpan.length };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["try_statement", "    try:\n        return load(p)\n    except ValueError as e:\n        log(e)"],
      ["block", clauseSpan, 0, "body"],
      ["expression_statement", "        log(e)"],
    ]);
    const from = src.indexOf("    except ValueError as e:");
    const to = clauseFrom;
    const v = editor(src, { anchor: from, head: to });
    expect(await planExtract(v)).toBe("the selection must start at a statement of the enclosing block");
  });

  it("refuses a view with no document", async () => {
    H.text = SRC;
    // No `lspDoc` field: `docOf` has nothing to answer for this view.
    view = new EditorView({
      state: EditorState.create({ doc: SRC, selection: { anchor: BODY_FROM, head: BODY_TO }, extensions: [history()] }),
    });
    expect(await planExtract(view)).toBe("no document");
  });

  it("refuses a statement the parser marked as broken", async () => {
    fixture();
    // The statement the selection starts in carries a parse error.
    const first = H.nodes.find((n) => n.kind === "if_statement")!;
    first.error = true;
    const v = editor(SRC, { anchor: BODY_FROM, head: BODY_TO });
    expect(await planExtract(v)).toBe("the selection contains syntax errors");
  });

  it("refuses a syntax error reported anywhere inside the selection", async () => {
    fixture();
    structureMock.syntaxErrors.mockResolvedValueOnce({
      errors: [
        {
          kind: "unexpected",
          range: rangeOf(BODY_FROM + 4, BODY_FROM + 5),
          expected: "=",
          message: "unexpected token",
        },
      ],
      truncated: false,
    });
    const v = editor(SRC, { anchor: BODY_FROM, head: BODY_TO });
    expect(await planExtract(v)).toBe("the selection contains syntax errors");
  });

  it("refuses a selection with no block at the caret", async () => {
    const v = editor(SRC, { anchor: 0, head: 10 });
    expect(await planExtract(v)).toBe("select statements inside a function");
  });

  it("refuses an empty selection", async () => {
    const v = editor(SRC, { anchor: BODY_FROM });
    expect(await planExtract(v)).toBe("select the statements to extract");
  });

  it("refuses a language without a syntax-only implementation", async () => {
    H.text = SRC;
    view = new EditorView({
      state: EditorState.create({
        doc: SRC,
        selection: { anchor: BODY_FROM, head: BODY_TO },
        extensions: [
          history(),
          lspDoc.of({ doc: 1, path: "/p/a.java", language: "java", uiMode: null, readOnly: false }),
        ],
      }),
    });
    expect(await planExtract(view)).toBe("Extract Method needs the language server for this language");
  });

  it("refuses a language the structure service cannot parse", async () => {
    structureMock.support.mockResolvedValueOnce({ tree: false, locals: false });
    const v = editor(SRC, { anchor: BODY_FROM, head: BODY_TO });
    expect(await planExtract(v)).toBe("Extract Method needs the language server here");
  });

  it("refuses a name whose scope is ambiguous", async () => {
    H.text = SRC;
    H.blockSpan = { from: BODY_FROM, to: BODY_TO };
    tree([
      ["module", SRC.trimEnd()],
      ["function_definition", SRC.trimEnd()],
      ["block", SRC.slice(BODY_FROM, BODY_TO), 0, "body"],
      ["if_statement", "    if order.discount:\n        rate = 0.9"],
      ["expression_statement", "        rate = 0.9"],
    ]);
    // `order` has two declarations in its scope: the service reports `certain: false`.
    const def = SRC.indexOf("(order)") + 1;
    const use = SRC.indexOf("order.discount");
    const ambiguous: Locals = {
      status: "local",
      symbol: {
        name: "order",
        kind: "var",
        definition: rangeOf(def, def + 5),
        scope: rangeOf(0, H.text.length),
        references: [rangeOf(use, use + 5)],
        certain: false,
        conflicts: [rangeOf(def, def + 5)],
      },
    };
    // Both the declaration and the use must answer ambiguously: the analysis
    // asks about the use, and an exact entry wins over the fixture fallback.
    H.localAt.set(def, ambiguous);
    H.localAt.set(use, ambiguous);
    const v = editor(SRC, { anchor: BODY_FROM, head: BODY_TO });
    expect(await planExtract(v)).toBe("'order' is declared more than once here");
  });

  it("returns every output the caller needs, in declaration order", async () => {
    const src = ["def f(a):", "    x = a + 1", "    y = a + 2", "    return x + y", ""].join("\n");
    const from = src.indexOf("    x = a + 1");
    const to = src.indexOf("    return x + y");
    H.text = src;
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.slice(from, to), 0, "body"],
      ["assignment", "x = a + 1"],
    ]);
    const param = src.indexOf("(a)") + 1;
    local("a", { from: param, to: param + 1 }, [{ from: src.indexOf("a + 1") + 0, to: src.indexOf("a + 1") + 1 }]);
    const xd = src.indexOf("x = a + 1");
    local("x", { from: xd, to: xd + 1 }, [{ from: src.indexOf("x + y"), to: src.indexOf("x + y") + 1 }]);
    const yd = src.indexOf("y = a + 2");
    local("y", { from: yd, to: yd + 1 }, [{ from: src.indexOf("x + y") + 4, to: src.indexOf("x + y") + 5 }]);
    const v = editor(src, { anchor: from, head: to });
    const plan = await planExtract(v);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.outputs).toEqual(["x", "y"]);
  });
});

describe("extractMethodFallback", () => {
  it("applies the call and the def as one undo step", async () => {
    fixture();
    const v = editor(SRC, { anchor: BODY_FROM, head: BODY_TO });
    expect(await extractMethodFallback(v)).toBe(true);

    const out = v.state.doc.toString();
    // The call replaces the statements; the def follows the enclosing function.
    expect(out).toContain("    rate = compute_rate(order)");
    expect(out).toContain("def compute_rate(order):");
    expect(out).toContain("    return rate");
    expect(out.indexOf("def compute_rate")).toBeGreaterThan(out.indexOf("return total"));

    expect(popup()?.kind).toBe("rename");
    useLspPopup.setState({ popup: null });

    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(SRC);
  });

  it("unpacks several outputs in one call statement", async () => {
    const src = ["def f(a):", "    x = a + 1", "    y = a + 2", "    return x + y", ""].join("\n");
    const from = src.indexOf("    x = a + 1");
    const to = src.indexOf("    return x + y");
    H.text = src;
    H.blockSpan = { from, to };
    tree([
      ["module", src.trimEnd()],
      ["function_definition", src.trimEnd()],
      ["block", src.slice(from, to), 0, "body"],
      ["assignment", "x = a + 1"],
      ["assignment", "y = a + 2"],
    ]);
    const param = src.indexOf("(a)") + 1;
    local("a", { from: param, to: param + 1 }, [{ from: src.indexOf("a + 1"), to: src.indexOf("a + 1") + 1 }]);
    const xd = src.indexOf("x = a + 1");
    local("x", { from: xd, to: xd + 1 }, [{ from: src.indexOf("x + y"), to: src.indexOf("x + y") + 1 }]);
    const yd = src.indexOf("y = a + 2");
    local("y", { from: yd, to: yd + 1 }, [{ from: src.indexOf("x + y") + 4, to: src.indexOf("x + y") + 5 }]);
    const v = editor(src, { anchor: from, head: to });
    expect(await extractMethodFallback(v)).toBe(true);

    const out = v.state.doc.toString();
    // The call unpacks the tuple the method returns; the method returns both.
    expect(out).toContain("    x, y = extracted(a)");
    expect(out).toContain("    return x, y");
    useLspPopup.setState({ popup: null });
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(src);
  });
});

describe("docs/extract-method-python.md", () => {
  it("lists every refusal message the implementation can return", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const doc = readFileSync(join(process.cwd(), "docs/extract-method-python.md"), "utf8");
    const source = readFileSync(join(process.cwd(), "src/editor/refactor/extractMethod.ts"), "utf8");

    // Fixed messages: quoted literals in `return "…"`.
    const fixed = new Set(
      [...source.matchAll(/return "((?:the selection|select statements|no document|Extract Method needs)[^"]*)"/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(fixed.size).toBeGreaterThan(10);

    // Templates are documented with their interpolations filled in, so match on
    // the surrounding text: the leading part before `${` and the trailing part.
    const templates = [...source.matchAll(/return `((?:the selection|')\S[^`]*?)`/g)]
      .map((m) => m[1]!)
      .filter((t) => !t.includes("${plan."));

    for (const message of fixed) {
      expect(doc, `missing from the doc: ${message}`).toContain(message);
    }
    for (const template of templates) {
      const [head, tail] = template.split(/\$\{[^}]*\}/);
      const rest = template.slice(template.indexOf(tail ?? "") || 0);
      expect(doc, `missing from the doc: ${template}`).toContain(head!.trimEnd());
      // The tail after the last interpolation is the part a reader recognizes.
      const lastChunk = (tail ?? rest).split(/\$\{[^}]*\}/).pop()!;
      expect(doc, `missing from the doc: ${template}`).toContain(lastChunk.trim());
    }
  });
});
