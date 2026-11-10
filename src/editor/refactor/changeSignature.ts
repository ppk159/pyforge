/**
 * Change Signature (⌃F6) without the language server.
 *
 * Two edits whose correctness the syntax can prove:
 *
 *  - **append a parameter with a default** — every existing call still binds the
 *    same parameters, so no call site changes;
 *  - **rename a parameter** — the signature and the body follow it, and so do
 *    the call sites that pass it by keyword. Positional call sites bind by
 *    position and are correctly left alone, which is why the occurrence's
 *    `role` matters.
 *
 * Reordering, removing, or adding a parameter without a default changes what a
 * call site means, so those are refused rather than guessed.
 *
 * The result is a `WorkspaceEdit`, so a rename that touches several files
 * applies as one atomic step through the workspace edit history — the same path
 * file moves take.
 */
import type { EditorView } from "@codemirror/view";
import type { IdentifierRole, Pos, Range, TextEdit, WorkspaceEdit } from "@/bindings";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange, rangeToOffsets } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { streamSearch } from "@/platform/textSearch";
import { useProject } from "@/platform/project";
import { spanOf } from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

/** What the refactoring does to the signature. */
export type SignatureChange =
  | { kind: "append"; name: string; def: string }
  | { kind: "rename"; from: string; to: string };

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
}

function refuse(view: EditorView, why: string): true {
  showHint(view, tx`Cannot perform refactoring: ${why}`);
  return true;
}

/** One item of a parameter list, trimmed, with its offsets in the signature. */
export interface ParamItem {
  text: string;
  from: number;
  to: number;
}

/**
 * The parameters inside `signature`'s parentheses, trimmed, with offsets.
 *
 * Commas inside brackets (a default `f(a, b)`, a tuple) do not split, so the
 * list is walked with a depth counter rather than split on every comma.
 */
export function parameterItems(signature: string): ParamItem[] | string {
  const open = signature.indexOf("(");
  if (open < 0) return "the declaration has no parameter list";
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i]!;
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return "the parameter list is not closed";

  const out: ParamItem[] = [];
  let depth2 = 0;
  let start = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = signature[i];
    if (c === "(" || c === "[" || c === "{") depth2++;
    else if (c === ")" || c === "]" || c === "}") depth2--;
    if ((c === "," && depth2 === 0) || i === close) {
      const raw = signature.slice(start, i);
      const lead = raw.length - raw.replace(/^\s+/, "").length;
      const trimmed = raw.trim();
      if (trimmed) out.push({ text: trimmed, from: start + lead, to: start + lead + trimmed.length });
      start = i + 1;
    }
  }
  return out;
}

/** The parameter's name: `b`, `b: int`, `b=2` → `b`. `*a` / `**k` → `a` / `k`. */
export function paramName(item: ParamItem): string {
  return item.text.split(/[:=]/)[0]!.replace(/^\*+/, "").trim();
}

/** Offset of the parameter's name inside its item. */
function nameOffset(item: ParamItem): number {
  const star = item.text.length - item.text.replace(/^\*+/, "").length;
  return item.from + star;
}

/**
 * `signature` with `name=default` appended, or why that cannot be done.
 *
 * Appending is the safe change: existing positional arguments still bind the
 * same parameters, and existing keyword arguments are untouched.
 */
export function appendParameter(
  signature: string,
  name: string,
  def: string,
): { text: string; parameter: string } | string {
  if (!/^[A-Za-z_]\w*$/.test(name)) return `'${name}' is not a valid parameter name`;
  const defaultValue = def.trim();
  if (!defaultValue) return "a new parameter needs a default so existing calls keep working";

  const items = parameterItems(signature);
  if (typeof items === "string") return items;
  if (items.some((item) => item.text.startsWith("*"))) return "the declaration takes *args or **kwargs";
  if (items.some((item) => paramName(item) === name)) return `the declaration already has a parameter '${name}'`;

  const parameter = `${name}=${defaultValue}`;
  if (!items.length) {
    const open = signature.indexOf("(");
    const close = signature.indexOf(")", open);
    return { text: `${signature.slice(0, open + 1)}${parameter}${signature.slice(close)}`, parameter };
  }
  // After the last parameter, which keeps every existing binding intact.
  const last = items[items.length - 1]!;
  return { text: `${signature.slice(0, last.to)}, ${parameter}${signature.slice(last.to)}`, parameter };
}

/** The `def …` line's offsets (up to the `:`) and its text, for the node at `pos`. */
export async function signatureAt(
  p: Prepared,
  pos: number,
): Promise<{ span: { from: number; to: number }; text: string; bodyFrom: number; fnTo: number } | string> {
  const doc = p.view.state.doc;
  const node = await structure.nodeAt(p.ctx.doc, offsetsToRange(doc, pos, pos)).catch(() => null);
  if (!node) return "the declaration could not be read";
  const fn = [node.node, ...node.ancestors].find((n) => n.kind === "function_definition");
  if (!fn) return "place the caret on a function declaration";
  const fnSpan = spanOf(doc, fn);
  const text = doc.sliceString(fnSpan.from, fnSpan.to);

  // The signature ends at the first `:` outside brackets and strings.
  let depth = 0;
  let quote: string | null = null;
  let colon = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return "the declaration has no signature";
  return {
    span: { from: fnSpan.from, to: fnSpan.from + colon },
    text: text.slice(0, colon),
    /** Where the body starts: just after the `:` that ends the signature. */
    bodyFrom: fnSpan.from + colon + 1,
    /** Where the whole declaration ends. */
    fnTo: fnSpan.to,
  };
}

/** A `WorkspaceEdit` of one file's replacements. */
function editOf(path: string, edits: TextEdit[]): WorkspaceEdit {
  return { files: [{ kind: "edit", path, edits, version: null }] };
}

/** Adds `edits` for `path` to `into`, merging with what is already there. */
function addFile(into: WorkspaceEdit, path: string, edits: TextEdit[]): void {
  if (!edits.length) return;
  const existing = into.files.find((f) => f.kind === "edit" && f.path === path);
  if (existing && existing.kind === "edit") existing.edits.push(...edits);
  else into.files.push({ kind: "edit", path, edits, version: null });
}

/** The project's Python files: the open one, plus every file mentioning `name`. */
export async function projectPythonFiles(ctx: EditorDocContext, name: string): Promise<string[]> {
  const found = new Set<string>([ctx.path.replace(/\\/g, "/")]);
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

/** Every occurrence of `name` in `files`, with the role the service assigns. */
export interface Occurrence {
  path: string;
  range: Range;
  role: IdentifierRole;
}

async function occurrencesIn(name: string, files: string[]): Promise<Occurrence[] | string> {
  let perFile;
  try {
    perFile = await structure.identifiersInFiles(files, name);
  } catch (e) {
    return `the occurrences of '${name}' could not be read (${String(e)})`;
  }
  return perFile.flatMap((file) =>
    file.occurrences.map((occ) => ({
      path: String(file.path).replace(/\\/g, "/"),
      range: occ.range,
      role: occ.role,
    })),
  );
}

/**
 * The parameter's own occurrences inside the function body.
 *
 * `locals` resolves the parameter to a symbol whose `references` are exactly the
 * body uses; a plain text search would also catch an unrelated local with the
 * same name in another function.
 */
async function bodyReferences(p: Prepared, pos: Pos, name: string): Promise<Range[] | string> {
  const answer = await structure.locals(p.ctx.doc, pos).catch(() => null);
  if (!answer || answer.status !== "local") return `the parameter '${name}' could not be resolved`;
  if (answer.symbol.name !== name) return `the parameter '${name}' could not be resolved`;
  if (!answer.symbol.certain) return `'${name}' is shadowed inside the body`;
  return answer.symbol.references;
}

/**
 * Everything that can make the change unsafe is checked before any edit.
 * Returns the reason instead of a plan when it cannot be done.
 *
 * `files` is the set of project files to search for call sites; the caller
 * collects it, so the plan stays testable without running a search.
 */
export async function planChangeSignature(
  view: EditorView,
  change: SignatureChange,
  files: string[],
): Promise<WorkspaceEdit | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Change Signature needs the language server for this language";
  await whenSynced(view);
  const p: Prepared = { view, ctx };
  const doc = view.state.doc;

  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Change Signature needs the language server here";

  const sel = view.state.selection.main;
  const signature = await signatureAt(p, sel.from);
  if (typeof signature === "string") return signature;
  const items = parameterItems(signature.text);
  if (typeof items === "string") return items;
  const names = items.map(paramName);
  if (names.some((n) => !/^[A-Za-z_]\w*$/.test(n))) return "a parameter name could not be read";
  if (items.some((item) => item.text.startsWith("*"))) return "the declaration takes *args or **kwargs";

  const path = ctx.path.replace(/\\/g, "/");
  const signatureRange = offsetsToRange(doc, signature.span.from, signature.span.to);

  if (change.kind === "append") {
    const made = appendParameter(signature.text, change.name, change.def);
    if (typeof made === "string") return made;
    return editOf(path, [{ range: signatureRange, new_text: made.text }]);
  }

  // Rename.
  if (!names.includes(change.from)) return `the declaration has no parameter '${change.from}'`;
  if (!/^[A-Za-z_]\w*$/.test(change.to)) return `'${change.to}' is not a valid parameter name`;
  if (names.includes(change.to)) return `the declaration already has a parameter '${change.to}'`;

  const item = items[names.indexOf(change.from)]!;
  const at = nameOffset(item);
  const newSignature = signature.text.slice(0, at) + change.to + signature.text.slice(at + change.from.length);
  const edit = editOf(path, [{ range: signatureRange, new_text: newSignature }]);

  // The body follows the parameter. `locals` gives exactly its references.
  const definitionPos = {
    line: doc.lineAt(at).number - 1,
    col: at - doc.lineAt(at).from,
  };
  const refs = await bodyReferences(p, definitionPos, change.from);
  if (typeof refs === "string") return refs;
  addFile(
    edit,
    path,
    refs.map((range) => ({ range, new_text: change.to })),
  );

  // A rename must not collide with a name the body already uses.
  const clash = await structure.identifiers(ctx.doc, change.to).catch(() => []);
  for (const occ of clash) {
    const at2 = rangeToOffsets(doc, occ.range);
    if (at2.from > signature.bodyFrom && at2.from < signature.fnTo) {
      return `'${change.to}' is already used in this function`;
    }
  }

  // Only a call that passes the parameter by keyword has to follow the rename;
  // a positional call binds by position and keeps working untouched.
  const sites = await occurrencesIn(change.from, files);
  if (typeof sites === "string") return sites;
  for (const site of sites) {
    if (site.role !== "keywordArgument") continue;
    addFile(edit, site.path, [{ range: site.range, new_text: change.to }]);
  }
  return edit;
}

/** Runs the change: prepares the edit (content fingerprints) then applies it. */
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

/** Appends a parameter with a default. */
export async function appendParameterFallback(view: EditorView, name: string, def: string): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const planned = await planChangeSignature(view, { kind: "append", name, def }, [ctx.path]);
    if (typeof planned === "string") return refuse(view, planned);
    if (view.state.doc !== before) return refuse(view, "the document changed");
    await applyEdit(view, planned);
    return true;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return false;
  }
}

/** Renames a parameter, following keyword call sites across the project. */
export async function renameParameterFallback(view: EditorView, from: string, to: string): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const files = await projectPythonFiles(ctx, from);
    const planned = await planChangeSignature(view, { kind: "rename", from, to }, files);
    if (typeof planned === "string") return refuse(view, planned);
    if (view.state.doc !== before) return refuse(view, "the document changed");
    await applyEdit(view, planned);
    return true;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return false;
  }
}
