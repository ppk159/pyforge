import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { ExpressionAt, Locals, NodeAt, Range, SyntaxNode } from "@/bindings";

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
}

const H = vi.hoisted(() => ({
  text: "",
  nodes: [] as FakeNode[],
  localAt: new Map<number, unknown>(),
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
    error: false,
    missing: false,
    hasError: false,
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
  syntaxErrors: vi.fn(async () => ({ errors: [], truncated: false })),
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
    return { status: "noIdentifier" as const };
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
    expect(typeof wholeStatements(doc(src), from, src.indexOf("    return"))).toBe("string");
  });

  it("refuses a selection that ends with a block head", () => {
    const src = "def f():\n    if x:\n        a = 1\n    return a\n";
    const from = src.indexOf("    if x:");
    const to = src.indexOf("        a = 1");
    expect(wholeStatements(doc(src), from, to)).toBe("the selection ends with the head of a block");
  });

  it("refuses return, global and match", () => {
    const r = (src: string) => {
      const start = src.indexOf("\n") + 1;
      return wholeStatements(doc(src), start, src.indexOf("\n", start));
    };
    expect(wholeStatements(doc("def f():\n    a = 1\n    return a\n"), 12, 36)).toBe(
      "the selection contains return, yield or await",
    );
    expect(r("def f():\n    a = 1 ; global g\n")).toBe("the selection declares a global or nonlocal name");
    // A whole `match` statement, not just its head.
    const m = "def f(v):\n    match v:\n        case 1:\n            pass\n    return None\n";
    const from = m.indexOf("    match v:");
    expect(wholeStatements(doc(m), from, m.indexOf("    return"))).toBe(
      "the selection contains a match statement, which the syntax service does not resolve",
    );
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
    output: "total",
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
    const voided = { ...plan, output: null, params: [] };
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
    expect(plan.output).toBe("rate");
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
    expect(plan.output).toBe("task");
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
    // `locals` answers noIdentifier for `tags` (the query gap the POC found).
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

  it("refuses a selection with no block at the caret", async () => {
    const v = editor(SRC, { anchor: 0, head: 10 });
    expect(await planExtract(v)).toBe("select statements inside a function");
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
});
