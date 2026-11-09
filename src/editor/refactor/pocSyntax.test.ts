/**
 * POC check: is the code Extract Method generates syntactically valid Python?
 *
 * Builds plans from realistic snippets (the shapes the syntax-only path has to
 * handle: a plain block, an if inside a block, a nested function, a for loop, a
 * trailing block, parameters and outputs), applies the same edits
 * `extractMethod.ts` applies, and has the real Python interpreter compile the
 * result. Problem 3 of the POC (does the edit leave the file analysable) starts
 * here: invalid text is a guaranteed false error in the Problems view.
 *
 *   pnpm vitest run ../scratch/poc-syntax.test.ts     # or copy into src/
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callText, declarationText, type ExtractPlan } from "@/editor/refactor/extractMethod";

const dir = mkdtempSync(join(tmpdir(), "poc-extract-"));

/**
 * The real interpreter. On Windows `python3` on PATH is the Store's app
 * execution alias: it exits 0 without running anything, so the launcher `py`
 * is the only reliable name there.
 */
const PYTHONS = process.platform === "win32" ? ["py", "python"] : ["python3", "python"];

function python(args: string[]): string | null {
  for (const exe of PYTHONS) {
    try {
      return execFileSync(exe, args, { stdio: "pipe", encoding: "utf8" });
    } catch (e) {
      const err = e as { code?: string; stderr?: Buffer };
      if (err.code === "ENOENT") continue;
      // The interpreter ran and rejected the code: report it, don't try another.
      throw new Error(String(err.stderr ?? e), { cause: e });
    }
  }
  return null;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Applies a plan exactly as `builder()` in extractMethod.ts does. */
function apply(src: string, plan: ExtractPlan, name: string): string {
  // Later edit first, so the earlier offsets stay valid.
  const withDef = src.slice(0, plan.insertAt) + `\n\n${declarationText(plan, name)}` + src.slice(plan.insertAt);
  return withDef.slice(0, plan.from) + callText(plan, name) + withDef.slice(plan.to);
}

/** Offsets of a snippet inside `src`, as the plan records them (`to` excludes the line break). */
function offsets(src: string, snippet: string) {
  const from = src.indexOf(snippet);
  if (from < 0) throw new Error(`no ${JSON.stringify(snippet)} in source`);
  const body = snippet.replace(/\n$/, "");
  return { from, to: from + body.length };
}

function compiles(src: string, label: string) {
  const file = join(dir, `${label}.py`);
  writeFileSync(file, src, "utf8");
  try {
    // `ast.parse` only reads; `py_compile` would also write bytecode next to it.
    const out = python(["-c", `import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())`, file]);
    if (out === null) throw new Error(`no Python interpreter found (tried ${PYTHONS.join(", ")})`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

interface Case {
  label: string;
  src: string;
  select: string;
  /** The enclosing function's last line: the def goes right after it. */
  after: string;
  params: string[];
  output: string | null;
  /** Indent of the selected statements. */
  indent: string;
  /** Indent of the enclosing function declaration; defaults to top level. */
  defIndent?: string;
}

const CASES: Case[] = [
  {
    label: "plain-block",
    src: [
      "def process(order):",
      "    total = 0",
      "    for item in order.items:",
      "        total += item.price",
      "    print(total)",
      "    return total",
      "",
    ].join("\n"),
    select: "    for item in order.items:\n        total += item.price\n",
    after: "    return total",
    params: ["order", "total"],
    output: "total",
    indent: "    ",
  },
  {
    label: "if-block",
    src: [
      "def process(order, total):",
      "    if order.discount:",
      "        total *= 0.9",
      "    if order.vip:",
      "        total *= 1.05",
      "    return total",
      "",
    ].join("\n"),
    select: "    if order.discount:\n        total *= 0.9\n    if order.vip:\n        total *= 1.05\n",
    after: "    return total",
    params: ["order", "total"],
    output: "total",
    indent: "    ",
  },
  {
    label: "no-params-no-output",
    src: ["def f():", "    a = 1", "    b = 2", "    return a + b", ""].join("\n"),
    select: "    a = 1\n    b = 2\n",
    after: "    return a + b",
    params: [],
    output: null,
    indent: "    ",
  },
  {
    label: "nested-function",
    src: [
      "def outer(a):",
      "    def inner(b):",
      "        c = b * 2",
      "        return c",
      "    return inner(a)",
      "",
    ].join("\n"),
    select: "        c = b * 2\n",
    after: "    return inner(a)",
    params: ["b"],
    output: "c",
    indent: "        ",
  },
  {
    label: "method-in-class",
    src: [
      "class TaskList:",
      "    def pending(self):",
      "        live = [t for t in self._tasks if not t.done]",
      "        return sorted(live, key=lambda t: -t.priority)",
      "",
    ].join("\n"),
    select: "        live = [t for t in self._tasks if not t.done]\n",
    after: "        return sorted(live, key=lambda t: -t.priority)",
    params: ["self"],
    output: "live",
    indent: "        ",
    // A sibling method: the enclosing function's own indent, not top level.
    defIndent: "    ",
  },
  {
    label: "trailing-block-at-eof",
    src: ["def f(x):", "    y = x + 1", "    print(y)", ""].join("\n"),
    select: "    y = x + 1\n    print(y)\n",
    after: "    print(y)",
    params: ["x"],
    output: null,
    indent: "    ",
  },
  {
    label: "with-statement",
    src: ["def read(p):", "    with open(p) as fh:", "        data = fh.read()", "    return data", ""].join("\n"),
    select: "    with open(p) as fh:\n        data = fh.read()\n",
    after: "    return data",
    params: ["p"],
    output: "data",
    indent: "    ",
  },
  {
    label: "try-body",
    src: [
      "def parse(p):",
      "    try:",
      "        raw = load(p)",
      "        return parse_json(raw)",
      "    except ValueError:",
      "        return None",
      "",
    ].join("\n"),
    select: "        raw = load(p)\n",
    // The enclosing function's last line, where the new def goes.
    after: "        return None",
    params: ["p"],
    output: "raw",
    indent: "        ",
    defIndent: "",
  },
  {
    label: "deep-indent",
    src: [
      "def f(items):",
      "    for i, it in enumerate(items):",
      "        if it.ok:",
      "            total = i * 2",
      "            print(total)",
      "    return None",
      "",
    ].join("\n"),
    select: "            total = i * 2\n            print(total)\n",
    after: "    return None",
    params: ["i"],
    output: null,
    indent: "            ",
    defIndent: "",
  },
  {
    label: "blank-line-inside",
    src: ["def f(a):", "    b = a + 1", "", "    c = b * 2", "    return c", ""].join("\n"),
    select: "    b = a + 1\n\n    c = b * 2\n",
    after: "    return c",
    params: ["a"],
    output: "c",
    indent: "    ",
  },
];

describe("generated Python compiles", () => {
  it.each(CASES)("$label", (c) => {
    const sel = offsets(c.src, c.select);
    const after = offsets(c.src, c.after);
    const plan: ExtractPlan = {
      from: sel.from,
      to: sel.to,
      body: c.src.slice(sel.from, sel.to),
      bodyIndent: c.indent,
      defIndent: c.defIndent ?? "",
      bodyIndentInner: c.indent,
      insertAt: after.to,
      params: c.params,
      output: c.output,
    };
    const out = apply(c.src, plan, "extracted");
    const result = compiles(out, c.label);
    if (!result.ok) {
      throw new Error(`${c.label}: generated code does not compile\n\n${out}\n\n${result.error}`);
    }
    expect(result.ok).toBe(true);
  });
});
