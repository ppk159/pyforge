import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import type { NodeAt, Range, SyntaxNode, WorkspaceEdit } from "@/bindings";

// --- a hand-built syntax tree over the test document -------------------------

interface FakeNode {
  kind: string;
  from: number;
  to: number;
  field: string | null;
  parent: FakeNode | null;
}

const H = vi.hoisted(() => ({ text: "", nodes: [] as FakeNode[], files: {} as Record<string, string> }));

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
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    call: async <T>(p: Promise<{ status: string; data?: T }>) => {
      const r = await p;
      if (r.status !== "ok") throw new Error("ipc error");
      return r.data as T;
    },
    commands: {
      ...actual.commands,
      fsReadText: async (path: string) =>
        path in H.files
          ? { status: "ok" as const, data: H.files[path]! }
          : { status: "error" as const, error: { kind: "notFound" as const, message: path } },
      prepareWorkspaceEdit: async (edit: WorkspaceEdit) => ({ status: "ok" as const, data: edit }),
      applyWorkspaceEdit: async () => ({ status: "ok" as const, data: null }),
    },
  };
});

const { lspDoc } = await import("@/editor/lsp/lsp");
const {
  definitionAt,
  moduleName,
  packageOf,
  importSites,
  boundNames,
  importBlockEnd,
  importsUsedBy,
  startOfBlankRun,
  planMove,
} = await import("./move");

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
        lspDoc.of({ doc: 1, path: "/p/tasks/models.py", language: "python", uiMode: null, readOnly: false }),
      ],
    }),
  });
  return view;
}

const PREP = () => ({
  view: view!,
  ctx: { doc: 1, path: "/p/tasks/models.py", language: "python", uiMode: null, readOnly: false },
});

function filesOf(edit: WorkspaceEdit) {
  return edit.files.filter((f) => f.kind === "edit");
}

function planned(result: unknown) {
  if (typeof result === "string") throw new Error(result);
  return result as never;
}

beforeEach(() => {
  H.nodes = [];
  H.text = "";
  H.files = {};
});

afterEach(() => {
  view?.destroy();
  view = null;
  showHint.mockClear();
});

// ---------------------------------------------------------------------------

describe("path helpers", () => {
  it("reads the module name", () => {
    expect(moduleName("/p/tasks/models.py")).toBe("models");
    expect(moduleName("C:\\p\\tasks\\models.py")).toBe("models");
    expect(moduleName("/p/tasks/__init__.py")).toBe("");
  });

  it("reads the package", () => {
    expect(packageOf("/p/tasks/models.py")).toBe("/p/tasks");
    expect(packageOf("C:\\p\\tasks\\models.py")).toBe("C:/p/tasks");
  });
});

describe("importSites", () => {
  it("finds a from-import of the name", () => {
    const text = "from .models import Task\n";
    expect(importSites(text, ".models", "Task")).toEqual([
      { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 24 } }, from: ".models", alias: null },
    ]);
  });

  it("keeps the alias", () => {
    const text = "from .models import Task as T\n";
    expect(importSites(text, ".models", "Task")[0]?.alias).toBe("T");
  });

  it("finds a name among several", () => {
    const text = "from .models import Priority, Task, TaskList\n";
    expect(importSites(text, ".models", "Task")).toHaveLength(1);
    expect(importSites(text, ".models", "Nope")).toHaveLength(0);
  });

  it("ignores another module", () => {
    expect(importSites("from .other import Task\n", ".models", "Task")).toHaveLength(0);
  });

  it("reads a parenthesised list", () => {
    const text = "from .models import (\n    Task,\n    TaskList,\n)\n";
    expect(importSites(text, ".models", "Task")).toHaveLength(1);
  });
});

describe("boundNames", () => {
  it("reads what an import line binds", () => {
    expect(boundNames("from .models import Task, Priority")).toEqual(["Task", "Priority"]);
    expect(boundNames("from .models import Task as T")).toEqual(["T"]);
    expect(boundNames("import os")).toEqual(["os"]);
    expect(boundNames("import os.path")).toEqual(["os"]);
    expect(boundNames("import os.path as p")).toEqual(["p"]);
  });
});

describe("importBlockEnd", () => {
  it("stops after the last import line", () => {
    const text = ["from __future__ import annotations", "", "import os", "", "class A:", "    pass", ""].join("\n");
    // Line 3 is the blank after `import os`; the block ends there, so the insertion
    // lands between the imports and the first definition.
    expect(importBlockEnd(text)).toBe(3);
  });

  it("is 0 when the file starts with code", () => {
    expect(importBlockEnd("class A:\n    pass\n")).toBe(0);
  });
});

describe("importsUsedBy", () => {
  const SRC = [
    "from __future__ import annotations",
    "from dataclasses import dataclass",
    "from datetime import date",
    "import os",
    "",
    "@dataclass",
    "class Task:",
    "    due: date | None = None",
    "",
  ].join("\n");

  it("carries __future__, the decorator and the annotated types", () => {
    const moved = SRC.slice(SRC.indexOf("@dataclass"));
    const needed = importsUsedBy(SRC, moved);
    expect(needed).toContain("from __future__ import annotations");
    expect(needed).toContain("from dataclasses import dataclass");
    expect(needed).toContain("from datetime import date");
    // `import os` is not used by the moved code.
    expect(needed).not.toContain("import os");
  });
});

describe("startOfBlankRun", () => {
  const text = "a = 1\n\n\nclass B:\n    pass\n\n\nc = 2\n";

  it("walks back over the blank lines", () => {
    const classAt = text.indexOf("class B");
    // The run starts right after `a = 1`: deleting from there removes the blanks.
    expect(startOfBlankRun(text, classAt, -1)).toBe(text.indexOf("a = 1") + "a = 1".length);
  });

  it("walks forward over the blank lines", () => {
    const end = text.indexOf("pass") + 4;
    expect(startOfBlankRun(text, end, 1)).toBe(text.indexOf("c = 2"));
  });
});

describe("definitionAt", () => {
  const DOC = ["class Task:", "    pass", "", "", "def helper(x):", "    return x", ""].join("\n");

  it("reads a top-level class", async () => {
    H.text = DOC;
    tree([
      ["module", DOC.trimEnd()],
      ["class_definition", "class Task:\n    pass"],
      ["identifier", "Task", 0, "name"],
      ["function_definition", "def helper(x):\n    return x"],
      ["identifier", "helper", 0, "name"],
    ]);
    const v = editor(DOC, DOC.indexOf("Task"));
    const def = await definitionAt(PREP(), DOC.indexOf("Task"));
    if (typeof def === "string") throw new Error(def);
    expect(def.name).toBe("Task");
    expect(def.kind).toBe("class");
    void v;
  });

  it("includes a decorator in the moved extent", async () => {
    const doc = ["@dataclass", "class Task:", "    pass", ""].join("\n");
    H.text = doc;
    tree([
      ["module", doc.trimEnd()],
      ["decorated_definition", "@dataclass\nclass Task:\n    pass"],
      ["class_definition", "class Task:\n    pass"],
      ["identifier", "Task", 0, "name"],
    ]);
    const v = editor(doc, doc.indexOf("Task"));
    const def = await definitionAt(PREP(), doc.indexOf("Task"));
    if (typeof def === "string") throw new Error(def);
    expect(def.from).toBe(0);
    void v;
  });

  it("refuses a nested declaration", async () => {
    const doc = ["class A:", "    def m(self):", "        pass", ""].join("\n");
    H.text = doc;
    tree([
      ["module", doc.trimEnd()],
      ["class_definition", "class A:\n    def m(self):\n        pass"],
      ["block", "    def m(self):\n        pass", 0, "body"],
      ["function_definition", "def m(self):\n        pass"],
      ["identifier", "m", 0, "name"],
    ]);
    const v = editor(doc, doc.indexOf("m("));
    expect(await definitionAt(PREP(), doc.indexOf("m("))).toBe(
      "the declaration is nested; only a top-level class or function can be moved",
    );
    void v;
  });
});

describe("planMove", () => {
  const MODELS = [
    "from __future__ import annotations",
    "",
    "from dataclasses import dataclass",
    "",
    "",
    "@dataclass",
    "class Task:",
    "    title: str",
    "",
    "",
    "class TaskList:",
    "    pass",
    "",
  ].join("\n");
  const CLI = "from .models import Task, TaskList\n\n\ndef f():\n    return Task\n";
  const DEST = "from __future__ import annotations\n\n\nclass Existing:\n    pass\n";
  const SRC_PATH = "/p/tasks/models.py";
  const DEST_PATH = "/p/tasks/extra.py";

  function fixture() {
    H.text = MODELS;
    H.files = { [SRC_PATH]: MODELS, "/p/tasks/cli.py": CLI, [DEST_PATH]: DEST };
    tree([
      ["module", MODELS.trimEnd()],
      ["decorated_definition", "@dataclass\nclass Task:\n    title: str"],
      ["class_definition", "class Task:\n    title: str"],
      ["identifier", "Task", 0, "name"],
      ["class_definition", "class TaskList:\n    pass"],
      ["identifier", "TaskList", 0, "name"],
    ]);
  }

  it("moves the class with the imports it needs", async () => {
    fixture();
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    const plan = planned(await planMove(v, { path: DEST_PATH }, [SRC_PATH, "/p/tasks/cli.py"]));
    const edit = (plan as { edit: WorkspaceEdit }).edit;
    const dest = filesOf(edit).find((f) => f.path === DEST_PATH);
    if (!dest) throw new Error("no destination edit");
    const inserted = dest.edits[0]!.new_text;
    // The decorator and its import travel with the class.
    expect(inserted).toContain("@dataclass");
    expect(inserted).toContain("class Task:");
    expect(inserted).toContain("from dataclasses import dataclass");
    // `__future__` is already in the destination, so it is not repeated.
    expect(inserted.match(/from __future__/g)).toBeNull();
  });

  it("keeps PEP 8 spacing around the new class", async () => {
    fixture();
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    const plan = planned(await planMove(v, { path: DEST_PATH }, [SRC_PATH, "/p/tasks/cli.py"]));
    const dest = filesOf((plan as { edit: WorkspaceEdit }).edit).find((f) => f.path === DEST_PATH)!;
    // Apply the insertion to the destination text and look at the result.
    const at = dest.edits[0]!.range.start;
    const lines = DEST.split("\n");
    let offset = 0;
    for (let i = 0; i < at.line; i++) offset += (lines[i] ?? "").length + 1;
    offset += at.col;
    const result = DEST.slice(0, offset) + dest.edits[0]!.new_text + DEST.slice(offset);

    // Two blank lines before the declaration and before what followed (PEP 8).
    expect(result).toContain("from dataclasses import dataclass\n\n\n@dataclass");
    expect(result).toContain("    title: str\n\n\nclass Existing:");
    expect(result).not.toContain("\n\n\n\n");
  });

  it("rewrites the import in the other file", async () => {
    fixture();
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    const plan = planned(await planMove(v, { path: DEST_PATH }, [SRC_PATH, "/p/tasks/cli.py"]));
    const edit = (plan as { edit: WorkspaceEdit }).edit;
    const cli = filesOf(edit).find((f) => f.path === "/p/tasks/cli.py");
    if (!cli) throw new Error(`no cli edit: ${JSON.stringify(filesOf(edit).map((f) => f.path))}`);
    expect(cli.edits[0]!.new_text).toBe("from .extra import Task");
  });

  it("keeps an alias when rewriting", async () => {
    H.text = MODELS;
    H.files = {
      [SRC_PATH]: MODELS,
      "/p/tasks/cli.py": "from .models import Task as T\n",
      [DEST_PATH]: DEST,
    };
    tree([
      ["module", MODELS.trimEnd()],
      ["decorated_definition", "@dataclass\nclass Task:\n    title: str"],
      ["class_definition", "class Task:\n    title: str"],
      ["identifier", "Task", 0, "name"],
    ]);
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    const plan = planned(await planMove(v, { path: DEST_PATH }, [SRC_PATH, "/p/tasks/cli.py"]));
    const cli = filesOf((plan as { edit: WorkspaceEdit }).edit).find((f) => f.path === "/p/tasks/cli.py");
    expect(cli?.edits[0]?.new_text).toBe("from .extra import Task as T");
  });

  it("refuses a destination that already defines the name", async () => {
    fixture();
    H.files[DEST_PATH] = "class Task:\n    pass\n";
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    expect(await planMove(v, { path: DEST_PATH }, [SRC_PATH])).toBe("'Task' is already defined in extra");
  });

  it("refuses a move to another package", async () => {
    fixture();
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    expect(await planMove(v, { path: "/p/other/extra.py" }, [SRC_PATH])).toBe("the destination is in another package");
  });

  it("refuses a move into __init__.py", async () => {
    fixture();
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    expect(await planMove(v, { path: "/p/tasks/__init__.py" }, [SRC_PATH])).toBe(
      "moving into __init__.py is not supported",
    );
  });

  it("refuses when the module-qualified form is used", async () => {
    fixture();
    H.files["/p/tasks/cli.py"] = "import tasks.models\n\n\ndef f():\n    return tasks.models.Task\n";
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    expect(await planMove(v, { path: DEST_PATH }, [SRC_PATH, "/p/tasks/cli.py"])).toBe("models.Task is used in cli.py");
  });

  it("refuses when nothing imports the name", async () => {
    fixture();
    H.files["/p/tasks/cli.py"] = "from .models import TaskList\n";
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    expect(await planMove(v, { path: DEST_PATH }, [SRC_PATH, "/p/tasks/cli.py"])).toBe(
      "nothing imports 'Task' from .models",
    );
  });

  it("refuses the same module", async () => {
    fixture();
    const v = editor(MODELS, MODELS.indexOf("Task:"));
    expect(await planMove(v, { path: SRC_PATH }, [SRC_PATH])).toBe("the destination is the same module");
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
    expect(await planMove(view, { path: "/p/b.java" }, ["/p/a.java"])).toBe(
      "Move needs the language server for this language",
    );
  });
});
