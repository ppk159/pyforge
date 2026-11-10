/**
 * Move a top-level class or function to another module of the same package,
 * rewriting the imports that follow it.
 *
 * v1 covers the case whose correctness the text can prove:
 *
 *  - source and destination sit in the same package, so relative imports keep
 *    their depth and no `__init__.py` needs touching;
 *  - the symbol is a top-level `class` / `def` (a decorator travels with it);
 *  - every `from <source-module> import <name>` becomes
 *    `from <dest-module> import <name>`, keeping any `as` alias;
 *  - the imports the moved code needs travel with it.
 *
 * Refused, with a hint: a nested declaration, a cross-package move, a
 * destination that already defines the name, a reference of the form
 * `<module>.<name>` (which cannot be rewritten with certainty), and a move that
 * nothing imports (then the symbol would simply vanish from view).
 */
import type { EditorView } from "@codemirror/view";
import type { Pos, Range, TextEdit, WorkspaceEdit } from "@/bindings";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { streamSearch } from "@/platform/textSearch";
import { useProject } from "@/platform/project";
import { firstContent, indentOf, spanOf } from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

/** Where the symbol goes. */
export interface MoveTarget {
  /** Absolute path of the destination module, e.g. `…/tasks/extra.py`. */
  path: string;
}

export interface MovePlan {
  /** The symbol's name, for the confirmation. */
  name: string;
  /** Module file names without extension, for the message. */
  fromModule: string;
  toModule: string;
  /** The workspace edit: destination extended, source trimmed, imports rewritten. */
  edit: WorkspaceEdit;
  /** How many import statements now point at the destination. */
  rewritten: number;
}

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
}

function refuse(view: EditorView, why: string): true {
  showHint(view, tx`Cannot perform refactoring: ${why}`);
  return true;
}

/** A top-level definition: its name, offsets, and the text to move. */
export interface Definition {
  name: string;
  /** Whole extent, decorators included. */
  from: number;
  to: number;
  kind: "class" | "function";
}

/**
 * The top-level definition the caret is on.
 *
 * Only a definition at column 0 whose parent is the module counts: a method or a
 * nested function cannot be moved without also moving its owner.
 */
export async function definitionAt(p: Prepared, pos: number): Promise<Definition | string> {
  const doc = p.view.state.doc;
  const node = await structure.nodeAt(p.ctx.doc, offsetsToRange(doc, pos, pos)).catch(() => null);
  if (!node) return "the declaration could not be read";

  const chain = [node.node, ...node.ancestors];
  const at = chain.findIndex((n) => n.kind === "class_definition" || n.kind === "function_definition");
  if (at < 0) return "place the caret on a class or function declaration";
  const inner = chain[at]!;
  // `decorated_definition` wraps the `def`, so look one further up when present.
  const container = chain[at + 1]?.kind === "decorated_definition" ? chain[at + 2] : chain[at + 1];
  if (container?.kind !== "module") {
    return "the declaration is nested; only a top-level class or function can be moved";
  }

  const innerSpan = spanOf(doc, inner);
  if (indentOf(doc, innerSpan.from)) {
    return "the declaration is indented; only a top-level class or function can be moved";
  }

  // The name is a child of the declaration, not an ancestor, so it comes from the
  // declaration's text: `class <name>` / `def <name>`.
  const head = doc.sliceString(innerSpan.from, Math.min(innerSpan.to, innerSpan.from + 400));
  const named = /^(?:class|def)\s+([A-Za-z_]\w*)/.exec(head);
  if (!named) return "the declaration's name could not be read";

  // A decorator belongs to the declaration the user sees; in the ancestor chain
  // it sits just outside the `class`/`def` node.
  const outer = chain[at + 1]?.kind === "decorated_definition" ? chain[at + 1]! : inner;
  const outerSpan = spanOf(doc, outer);
  return {
    name: named[1]!,
    from: outerSpan.from,
    to: outerSpan.to,
    kind: inner.kind === "class_definition" ? "class" : "function",
  };
}

/** `…/tasks/models.py` → `models`. `__init__.py` → `""` (the package itself). */
export function moduleName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem = file.replace(/\.py$/, "");
  return stem === "__init__" ? "" : stem;
}

/** The directory a module path lives in. */
export function packageOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

/** Byte offset → `Pos`, for text that is not a CodeMirror document. */
export function posOfText(text: string, offset: number): Pos {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length - 1, col: offset - (before.lastIndexOf("\n") + 1) };
}

/** One `from X import a, b as c` statement mentioning the moved name. */
export interface ImportSite {
  /** Offsets of the whole statement in its file. */
  range: Range;
  /** The module part as written, e.g. `.models` or `pkg.models`. */
  from: string;
  /** The `as` alias, kept in the rewrite. */
  alias: string | null;
}

/**
 * Every `from <module> import …` statement in `text` that imports `name`.
 *
 * A statement may span lines inside parentheses, so a `from` line is followed to
 * its closing bracket before the names are read. One statement can import
 * several names and only one of them moves, so the answer is per name: the match
 * returns the whole statement, which the rewrite rebuilds with the one name.
 */
export function importSites(text: string, module: string, name: string): ImportSite[] {
  const out: ImportSite[] = [];
  const re = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([^\n]*)/gm;
  for (const m of text.matchAll(re)) {
    if (m[1] !== module) continue;
    let body = m[2]!;
    let end = m.index! + m[0]!.length;
    // A trailing `(` continues the list on the following lines.
    if (body.includes("(") && !body.includes(")")) {
      const rest = text.slice(end);
      const close = rest.indexOf(")");
      if (close < 0) continue;
      body += rest.slice(0, close + 1);
      end += close + 1;
    }
    const names = body.replace(/#.*$/, "").replace(/[()]/g, "");
    const pieces = names
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const match = pieces.map((p) => /^(\w+)(?:\s+as\s+(\w+))?$/.exec(p)).find((hit) => hit && hit[1] === name);
    if (!match) continue;
    out.push({
      range: { start: posOfText(text, m.index!), end: posOfText(text, end) },
      from: m[1]!,
      alias: match[2] ?? null,
    });
  }
  return out;
}

/** The names an import line binds. */
export function boundNames(line: string): string[] {
  const from = /^from\s+\S+\s+import\s+(.+)$/.exec(line);
  if (from) {
    return from[1]!
      .replace(/[()]/g, "")
      .split(",")
      .map((p) => {
        const alias = /\bas\s+(\w+)$/.exec(p.trim());
        return alias ? alias[1]! : p.trim();
      })
      .filter(Boolean);
  }
  const plain = /^import\s+(.+)$/.exec(line);
  if (plain) {
    return plain[1]!.split(",").map((p) => {
      const text = p.trim();
      const alias = /\bas\s+(\w+)$/.exec(text);
      return alias ? alias[1]! : (text.split(".")[0] ?? "");
    });
  }
  return [];
}

/** The import block at the top of `text`: its last line index (exclusive). */
export function importBlockEnd(text: string): number {
  const lines = text.split("\n");
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) {
      // A blank line inside the block does not end it, but it only counts once
      // something after it turns out to be part of the block.
      continue;
    }
    if (/^(from|import)\s/.test(trimmed) || /^[)\]}]/.test(trimmed)) {
      end = i + 1;
      continue;
    }
    break;
  }
  return end;
}

/**
 * The import lines the moved text needs, in source order.
 *
 * A name is needed when the moved code mentions a name the line binds. `from
 * __future__` always travels: every module keeps it, and dropping it would
 * change annotation semantics.
 */
export function importsUsedBy(sourceText: string, movedText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of sourceText.split("\n")) {
    const trimmed = line.trim();
    if (!/^(from|import)\s/.test(trimmed)) continue;
    if (
      !/^from __future__\s/.test(trimmed) &&
      !boundNames(trimmed).some((b) => new RegExp(`\\b${b}\\b`).test(movedText))
    ) {
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** The project's Python files, from a search for `name`. */
export async function projectFiles(name: string): Promise<string[]> {
  const found = new Set<string>();
  const root = useProject.getState().project?.root;
  if (!root) return [...found];
  await streamSearch(
    nextRequestId(),
    {
      pattern: name,
      isRegex: false,
      caseSensitive: true,
      wholeWord: true,
      include: ["*.py"],
      exclude: [],
      scope: { kind: "project" },
      maxMatches: 5000,
    },
    (file) => found.add(String(file.path).replace(/\\/g, "/")),
  ).catch(() => null);
  return [...found];
}

/** A file's text: the open buffer when it is the one being edited, else disk. */
async function textAt(path: string, open: { path: string; text: string } | null): Promise<string | null> {
  if (open && open.path === path) return open.text;
  const result = await call(commands.fsReadText(path)).catch(() => null);
  return result == null ? null : String(result);
}

/** Adds an edit to a file in the workspace edit, creating the entry if needed. */
function addEdit(edit: WorkspaceEdit, path: string, textEdit: TextEdit): void {
  const existing = edit.files.find((f) => f.kind === "edit" && f.path === path);
  if (existing && existing.kind === "edit") existing.edits.push(textEdit);
  else edit.files.push({ kind: "edit", path, version: null, edits: [textEdit] });
}

/**
 * Everything that can make the move unsafe is checked before any edit.
 *
 * `files` is the set of project files to examine; the caller collects it, so the
 * plan stays testable without running a search.
 */
export async function planMove(view: EditorView, target: MoveTarget, files: string[]): Promise<MovePlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Move needs the language server for this language";
  await whenSynced(view);
  const p: Prepared = { view, ctx };
  const doc = view.state.doc;

  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Move needs the language server here";

  const sel = view.state.selection.main;
  const def = await definitionAt(p, firstContent(doc, sel.from, sel.to));
  if (typeof def === "string") return def;

  const sourcePath = ctx.path.replace(/\\/g, "/");
  const destPath = target.path.replace(/\\/g, "/");
  if (sourcePath === destPath) return "the destination is the same module";
  // Relative imports keep their depth only inside one package.
  if (packageOf(sourcePath) !== packageOf(destPath)) return "the destination is in another package";

  const sourceModule = moduleName(sourcePath);
  const destModule = moduleName(destPath);
  if (sourceModule === destModule) return "the destination is the same module";
  if (!destModule) return "moving into __init__.py is not supported";

  const sourceText = doc.toString();
  const open = { path: sourcePath, text: sourceText };
  const destText = await textAt(destPath, open);
  if (destText === null) return `the destination could not be read: ${destPath}`;
  if (new RegExp(`^\\s*(class|def)\\s+${def.name}\\b`, "m").test(destText)) {
    return `'${def.name}' is already defined in ${destModule}`;
  }

  // `<module>.<name>` cannot be rewritten with certainty, so it blocks the move.
  const qualified = new RegExp(`\\b${sourceModule}\\s*\\.\\s*${def.name}\\b`);
  for (const file of files) {
    if (file === sourcePath) continue;
    const text = await textAt(file, open);
    if (text && qualified.test(text)) return `${sourceModule}.${def.name} is used in ${file.split("/").pop()}`;
  }

  const movedText = sourceText.slice(def.from, def.to);
  const needed = importsUsedBy(sourceText, movedText).filter((line) => !destText.includes(line));
  const blockEnd = importBlockEnd(destText);
  const lines = destText.split("\n");

  // Insert after the import block, keeping PEP 8 spacing: one blank line after
  // the imports, two before whatever follows a top-level class.
  let insertAt = 0;
  if (blockEnd > 0) insertAt = lines.slice(0, blockEnd).join("\n").length + 1;

  // PEP 8 wants two blank lines around a top-level class, and that is what the
  // source file had; `insertAt` sits right after the newline that ends the last
  // import, so two more newlines leave two blank lines before the declaration.
  const imports = needed.length ? needed.join("\n") + "\n\n\n" : "\n\n";
  const lead = insertAt === 0 ? "" : "\n";
  // Trailing: the moved text's own newline, then enough blank lines to reach two
  // before whatever follows. The destination's blank lines after the insertion
  // point are counted so the result never grows a third one.
  const rest = destText.slice(insertAt);
  const existingBlanks = (/^\n*/.exec(rest)?.[0] ?? "").length;
  const after = rest.trim() ? "\n".repeat(Math.max(1, 3 - existingBlanks)) : "\n";

  const edit: WorkspaceEdit = { files: [] };
  addEdit(edit, destPath, {
    range: {
      start: posOfText(destText, insertAt),
      end: posOfText(destText, insertAt),
    },
    new_text: `${lead}${imports}${movedText}${after}`,
  });

  // The source loses the definition and the blank lines that framed it, so the
  // file keeps its shape instead of gaining a gap.
  const blockFrom = startOfBlankRun(sourceText, def.from, -1);
  const blockTo = startOfBlankRun(sourceText, def.to, +1);
  addEdit(edit, sourcePath, {
    range: offsetsToRange(doc, blockFrom, blockTo),
    new_text: blockFrom > 0 && blockTo < sourceText.length ? "\n\n" : "",
  });

  // Every `from <source> import <name>` now points at the destination.
  let rewritten = 0;
  const seenFiles = new Map<string, string>();
  for (const file of [sourcePath, ...files.filter((f) => f !== sourcePath)]) {
    const text = seenFiles.get(file) ?? (await textAt(file, open));
    if (text === null) continue;
    seenFiles.set(file, text);
    for (const site of [...importSites(text, `.${sourceModule}`, def.name)]) {
      addEdit(edit, file, {
        range: site.range,
        new_text: `from .${destModule} import ${def.name}${site.alias ? ` as ${site.alias}` : ""}`,
      });
      rewritten++;
    }
  }
  if (!rewritten) return `nothing imports '${def.name}' from .${sourceModule}`;

  return { name: def.name, fromModule: sourceModule, toModule: destModule, edit, rewritten };
}

/**
 * Where a run of blank lines starts, walking away from `at`.
 *
 * `direction` is -1 to walk backwards (finding the blank lines before the
 * declaration) and +1 to walk forwards (the ones after it). The offset returned
 * is the far edge of the run, which is what the deletion must cover.
 */
export function startOfBlankRun(text: string, at: number, direction: 1 | -1): number {
  const isBlank = (c: string) => c === "\n" || c === "\r" || c === " " || c === "\t";
  let i = at;
  if (direction < 0) {
    // Walk back over the blank run, then over the newline that ends the
    // previous line, so the run itself is part of the deletion.
    while (i > 0 && isBlank(text[i - 1]!)) i--;
    return i;
  }
  while (i < text.length && isBlank(text[i]!)) i++;
  return i;
}

/** Runs the move: prepares the edit (content fingerprints) then applies it. */
async function applyEdit(view: EditorView, edit: WorkspaceEdit): Promise<boolean> {
  try {
    const prepared = await call(commands.prepareWorkspaceEdit(edit));
    await call(commands.applyWorkspaceEdit(prepared));
    view.focus();
    return true;
  } catch (e) {
    showHint(view, tx`Cannot perform refactoring: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

/** Moves the top-level definition under the caret to `target`. */
export async function moveFallback(view: EditorView, target: MoveTarget): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const sel = view.state.selection.main;
    const def = await definitionAt({ view, ctx }, firstContent(before, sel.from, sel.to));
    const files = typeof def === "string" ? [ctx.path] : await projectFiles(def.name);
    const planned = await planMove(view, target, files.length ? files : [ctx.path]);
    if (typeof planned === "string") return refuse(view, planned);
    if (view.state.doc !== before) return refuse(view, "the document changed");
    await applyEdit(view, planned.edit);
    return true;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return false;
  }
}
