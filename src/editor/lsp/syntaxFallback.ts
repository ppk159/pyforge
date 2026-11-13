/**
 * Syntax fallbacks for navigation, highlighting and rename (IDEA's dumb mode):
 * used only when the language server is not ready / failing (or, for rename,
 * answers nothing over code with syntax errors). Everything here claims only
 * what the structure service is certain about; ambiguity becomes candidates.
 */
import type { ChangeSpec, Text } from "@codemirror/state";
import type { IdentifierRole, Location, Pos, Range, SymbolKind, SymbolMatch } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { structure, type Locals, type LocalSymbol, type NodeAt } from "@/editor/structure";
import { comparePos, rangeContains, rangeToOffsets } from "./positions";
import { tx } from "@/platform/i18n";

/** Subtle marker for answers that did not come from the language server. */
export const SYNTAX_NOTE = "Based on syntax (language server not ready)";

/** A declaration candidate; index symbols carry their name, kind and container. */
export interface DeclarationTarget extends Location {
  name?: string;
  kind?: SymbolKind;
  container?: string | null;
}

export type DeclarationFallback =
  /** No grammar for the language: the fallback has nothing to say. */
  | { kind: "unsupported" }
  /** Certain local definition, or every index symbol of that name and role. */
  | { kind: "targets"; targets: DeclarationTarget[]; ambiguous: boolean };

const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set([
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "typeAlias",
  "typeParameter",
]);
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(["function", "method", "constructor", "macro", ...TYPE_KINDS]);
const NON_DECLARATIONS: ReadonlySet<SymbolKind> = new Set(["file", "package", "module", "namespace", "unknown"]);

export type UsageRole = "type" | "call" | "new" | "other";

const TYPE_NODE = /(^|_)type_identifier$|^user_type$|^scoped_type_identifier$/;
const TYPE_PARENT =
  /^(generic_type|user_type|nullable_type|type_annotation|type_arguments|scoped_type_identifier|qualified_type|array_type)$/;
const CALL_PARENT = /(^|_)(call|invocation)(_expression)?$|^call$/;
const NEW_PARENT = /^(new_expression|object_creation_expression|instance_creation_expression|constructor_invocation)$/;

/** What the syntax tree tells about the identifier: a type reference, a call, a `new`… */
export function usageRole(at: NodeAt | null): UsageRole {
  if (!at) return "other";
  const { node } = at;
  const parent = at.ancestors[0];
  if (parent && NEW_PARENT.test(parent.kind)) return "new";
  if (TYPE_NODE.test(node.kind) || node.field === "type" || (parent && TYPE_PARENT.test(parent.kind))) return "type";
  if (
    parent &&
    CALL_PARENT.test(parent.kind) &&
    (node.field === "function" || node.field === "name" || node.field == null)
  )
    return "call";
  return "other";
}

/** Index symbols that may be the declaration of `name` used in `role`. */
export function filterSymbols(matches: readonly SymbolMatch[], name: string, role: UsageRole): SymbolMatch[] {
  return matches.filter((m) => {
    if (m.name !== name || NON_DECLARATIONS.has(m.kind)) return false;
    switch (role) {
      case "type":
      case "new":
        return TYPE_KINDS.has(m.kind) || m.kind === "constructor";
      case "call":
        return CALLABLE_KINDS.has(m.kind);
      default:
        return true;
    }
  });
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** Extensions whose code can reference each other's declarations. */
const FAMILIES: readonly string[][] = [
  ["java", "kt", "kts", "scala", "groovy"],
  ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte"],
  ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"],
  ["py", "pyi"],
  ["rb", "rake"],
  ["ex", "exs"],
  ["hs", "lhs"],
];

/** Whether a declaration in `target` can be referenced from code in `from` (same language family). */
export function compatibleFiles(from: string, target: string): boolean {
  const a = extensionOf(from);
  const b = extensionOf(target);
  if (!a || a === b) return true;
  const family = FAMILIES.find((f) => f.includes(a));
  return family ? family.includes(b) : false;
}

/**
 * The class a member access is known to be on, from syntax alone.
 *
 * `factory_dao.query(...)` says nothing about a type, but when this file also
 * holds `factory_dao = FactoryDao(…)` the declaration is a syntactic fact: the
 * right-hand side is a bare name that the index knows as a class. This is the
 * one case the fallback may use to narrow candidates; every other shape (a call
 * result, an element of a list, a parameter) stays "any member of that name".
 *
 * Returns the class name, or null when the file does not say.
 */
export function assignedClassName(
  text: Text,
  occurrences: readonly { range: Range; qualified: boolean }[],
  name: string,
): string | null {
  for (const o of occurrences) {
    if (o.qualified) continue;
    const { from, to } = rangeToOffsets(text, o.range);
    const lineStart = text.lineAt(from).from;
    const lineEnd = text.lineAt(to).to;
    const line = text.sliceString(lineStart, lineEnd);
    // `name = Class(...)` / `name: T = Class(...)`, nothing else on that side.
    // Escape the name (it is an identifier, but `$` is legal in some languages)
    // and keep the backslashes literal through `String.raw`.
    const m = new RegExp(String.raw`^\s*${name}\s*(?::[^=]+)?=\s*([\p{Lu}][\p{L}\p{N}_]*)\s*\(`, "u").exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Current file first, then files of the same extension, then by path / position.
 *
 * `container` breaks the ties the path cannot: when the caller knows the member
 * belongs to one class (`FactoryDao`), its own members come before the same name
 * on any other class.
 */
/**
 * Module files a local name may come from, most specific first, from the file's own
 * import statements.
 *
 * `from a.b import c` is ambiguous in the source text alone: `c` is either a module
 * (`a/b/c.py`) or a name inside `a/b.py`. Both paths are returned and a candidate that
 * matches either wins — the file itself is the witness.
 */
export function importedModulePaths(text: Text, name: string): string[] {
  const source = text.toString();
  const out: string[] = [];
  const slashed = (mod: string) => mod.replace(/\./g, "/");
  for (const m of source.matchAll(/^[ 	]*from[ 	]+([\w.]+)[ 	]+import[ 	]+(.+)$/gm)) {
    const mod = m[1]!;
    for (const part of m[2]!.split(",")) {
      const words = part
        .trim()
        .replace(/[()]/g, "")
        .split(/\s+as\s+/);
      const imported = words[0]?.trim();
      const local = (words[1] ?? words[0])?.trim();
      if (!imported || local !== name) continue;
      out.push(`${slashed(mod)}/${imported}.py`, `${slashed(mod)}.py`);
    }
  }
  for (const m of source.matchAll(/^[ 	]*import[ 	]+([\w.]+)(?:[ 	]+as[ 	]+(\w+))?/gm)) {
    const mod = m[1]!;
    const local = m[2] ?? mod.split(".")[0]!;
    if (local === name) out.push(`${slashed(mod)}.py`);
  }
  return out;
}

/**
 * Order candidates by what the syntax actually says about them.
 *
 * `container` (the class this file binds the object to) is the strongest signal, then
 * `modules` (the files the receiver was imported from), then the current file, then the
 * extension family. The current file is *last* among these on purpose: for `obj.method`
 * the object is usually something this module imported, so preferring a same-named
 * method of the file's own class picked the wrong one often enough to be a bug.
 */
export function rankTargets<T extends Location & { container?: string | null }>(
  targets: readonly T[],
  currentPath: string,
  container?: string | null,
  modules: readonly string[] = [],
): T[] {
  const ext = extensionOf(currentPath);
  const fromModule = (t: T) => modules.some((m) => t.path.endsWith(`/${m}`) || t.path.endsWith(m));
  const rank = (t: T) => {
    if (container && t.container === container) return 0;
    if (fromModule(t)) return 1;
    if (container && t.container) return 3;
    return t.path === currentPath ? 2 : extensionOf(t.path) === ext ? 4 : 6;
  };
  return [...targets].sort(
    (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || comparePos(a.range.start, b.range.start),
  );
}

function sameRange(a: Range, b: Range) {
  return comparePos(a.start, b.start) === 0 && comparePos(a.end, b.end) === 0;
}

/** Local declaration targets: the definition when certain, else every same-scope declaration. */
export function localTargets(path: string, symbol: LocalSymbol): { targets: DeclarationTarget[]; ambiguous: boolean } {
  const ranges = symbol.certain ? [symbol.definition] : [symbol.definition, ...symbol.conflicts];
  const unique = ranges.filter((r, i) => ranges.findIndex((o) => sameRange(o, r)) === i);
  unique.sort((a, b) => comparePos(a.start, b.start));
  return {
    targets: unique.map((range) => ({ path, range, name: symbol.name })),
    ambiguous: unique.length > 1,
  };
}

const SYMBOL_LIMIT = 500;

/**
 * Go to Declaration without a language server: a certain local definition,
 * otherwise project index symbols with exactly that name (filtered by the
 * syntactic role when the tree tells). Call after `whenSynced`.
 */
export async function declarationFallback(
  doc: { doc: number; path: string; language: string },
  text: Text,
  pos: Pos,
  signal?: AbortSignal,
): Promise<DeclarationFallback> {
  const support = await structure.support(doc.language);
  if (!support.tree) return { kind: "unsupported" };
  let locals: Locals | null = null;
  if (support.locals) locals = await structure.locals(doc.doc, pos, { signal });
  if (locals?.status === "noIdentifier") return { kind: "targets", targets: [], ambiguous: false };
  if (locals?.status === "local") return { kind: "targets", ...localTargets(doc.path, locals.symbol) };

  const at = await structure.nodeAt(doc.doc, { start: pos, end: pos }, { signal });
  const name = locals?.status === "notLocal" ? locals.name : identifierText(text, at);
  if (!name) return { kind: "targets", targets: [], ambiguous: false };
  // A member (`obj.name`) can be any member of that name; only a plain name has a syntactic role.
  const member = locals?.status === "notLocal" && locals.reason === "member";
  const role = member ? "other" : usageRole(at);
  const matches = await call(commands.findSymbols(name, "all", SYMBOL_LIMIT));
  const symbols = filterSymbols(matches, name, role).filter((s) => compatibleFiles(doc.path, s.path));
  // `obj.name` where this file also says `obj = Class(…)`: the class is a syntactic
  // fact, so its own members come first. Everything else stays "any member".
  const origin = member
    ? await memberOrigin(doc, text, at, signal)
    : { container: null as string | null, modules: [] as string[] };
  const targets = rankTargets(
    symbols.map((s) => ({ path: s.path, range: s.range, name: s.name, kind: s.kind, container: s.container })),
    doc.path,
    origin.container,
    origin.modules,
  );
  return { kind: "targets", targets, ambiguous: targets.length > 1 };
}

/**
 * The class a member access is certainly on, when the same file binds the object
 * to one. Resolves the receiver's name from the `attribute` node, then looks for
 * `receiver = Class(…)` among this file's identifiers.
 */
/** The bare name an `obj.method` access is on, or null when it is not a plain name. */
export function receiverName(text: Text, at: NodeAt | null): string | null {
  const attribute = at?.ancestors.find((a) => MEMBER_ACCESS.has(a.kind));
  if (!attribute) return null;
  const { from, to } = rangeToOffsets(text, attribute.range);
  const source = text.sliceString(from, to);
  // `a.b.c` → the receiver is everything before the last dot; only a bare name is
  // something this file can bind to a class or a module.
  const dot = source.lastIndexOf(".");
  if (dot <= 0) return null;
  const receiver = source.slice(0, dot).trim();
  return IDENT.test(receiver) ? receiver : null;
}

/** What `obj.method` says about where `method` lives, from this file alone. */
export async function memberOrigin(
  doc: { doc: number; path: string; language: string },
  text: Text,
  at: NodeAt | null,
  signal?: AbortSignal,
): Promise<{ container: string | null; modules: string[] }> {
  const receiver = receiverName(text, at);
  if (!receiver) return { container: null, modules: [] };
  const occurrences = await structure.identifiers(doc.doc, receiver, { signal });
  // `plan_service = PlanService()` binds the class; `from … import plan_service` binds
  // the module. Either is a syntactic fact about this file.
  return {
    container: assignedClassName(text, occurrences, receiver),
    modules: importedModulePaths(text, receiver),
  };
}

/** Node kinds whose text is `receiver.member`. */
const MEMBER_ACCESS: ReadonlySet<string> = new Set([
  "attribute",
  "member_expression",
  "field_expression",
  "selector_expression",
]);

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Name of a leaf identifier node (languages without `locals.scm`). */
function identifierText(text: Text, at: NodeAt | null): string | null {
  if (!at || !/identifier|^name$|^constant$|^word$/.test(at.node.kind)) return null;
  const { from, to } = rangeToOffsets(text, at.node.range);
  const name = text.sliceString(from, to);
  return IDENT.test(name) ? name : null;
}

/** Whether `targets` is just the declaration the caret is on (IDEA then shows usages). */
export function isSelfTarget(targets: readonly Location[], path: string, pos: Pos): boolean {
  return targets.length === 1 && targets[0]!.path === path && rangeContains(targets[0]!.range, pos);
}

// ---------------------------------------------------------------------------
// Highlight usages

export interface LocalHighlight {
  range: Range;
  kind: "write" | "text";
}

/** Same-scope occurrences of a certain local (the definition marked as a write). */
export function localHighlights(locals: Locals): LocalHighlight[] | null {
  if (locals.status !== "local" || !locals.symbol.certain) return null;
  const { symbol } = locals;
  return [
    { range: symbol.definition, kind: "write" as const },
    ...symbol.references.map((range) => ({ range, kind: "text" as const })),
  ].sort((a, b) => comparePos(a.range.start, b.range.start));
}

/**
 * Names a file imports, as `(name, line)` — `from a.b import c` binds `c`,
 * `from a.b import c as d` binds `d`, `import a.b as e` binds `e` (a plain
 * `import a.b` binds `a`).
 *
 * A module or an imported function is out of scope for `locals`, so highlighting it
 * went nowhere; these bindings are certain from the import statement alone.
 */
export function importedBindings(text: Text): Map<string, number> {
  const out = new Map<string, number>();
  const source = text.toString();
  const lineOf = (index: number) => text.lineAt(index).number - 1;
  const add = (name: string, index: number) => {
    if (!out.has(name)) out.set(name, lineOf(index));
  };
  const from = /^[ 	]*from[ 	]+[\w.]+[ 	]+import[ 	]+(.+)$/gm;
  for (const m of source.matchAll(from)) {
    for (const part of parenList(m[1]!)) {
      const words = part.split(/\s+as\s+/);
      const imported = words[0]?.trim();
      const local = (words[1] ?? words[0])?.trim();
      if (!imported || !local || !IDENT.test(local)) continue;
      // A name imported from a package may be a module or a member; either way the
      // statement is where this file binds it.
      add(local, (m.index ?? 0) + m[0].length - m[1]!.length + m[1]!.indexOf(part));
    }
  }
  const plain = /^[ 	]*import[ 	]+([\w.]+(?:[ 	]+as[ 	]+\w+)?(?:[ 	]*,[ 	]*[\w.]+(?:[ 	]+as[ 	]+\w+)?)*)/gm;
  for (const m of source.matchAll(plain)) {
    let offset = (m.index ?? 0) + m[0].length - m[1]!.length;
    for (const part of m[1]!.split(",")) {
      const words = part.trim().split(/\s+as\s+/);
      const dotted = words[0]?.trim();
      // `import a.b` binds `a`; `import a.b as c` binds `c`.
      const local = (words[1] ?? dotted?.split(".")[0])?.trim();
      if (local && IDENT.test(local)) add(local, offset + (part.length - part.trimStart().length));
      offset += part.length + 1;
    }
  }
  return out;
}

/** The names of a possibly parenthesized, possibly multi-line `import` list. */
function parenList(raw: string): string[] {
  const inner = raw.trim().replace(/^\(/, "").replace(/\)$/, "");
  return inner
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Highlighter for a name this file imported: the binding line plus every occurrence
 * that is not a member access, a keyword argument or a string/comment (the structure
 * service already leaves the last two out of `identifiers`).
 *
 * Narrower than a real reference search on purpose — a same-named local elsewhere in
 * the file is not the import, and marking it would be a lie.
 */
export function importedHighlights(
  occurrences: readonly { range: Range; qualified: boolean; role: IdentifierRole }[],
  bindingLine: number,
): LocalHighlight[] {
  const binding = occurrences.find(
    (o) => o.range.start.line === bindingLine && !o.qualified && o.role !== "parameter" && o.role !== "keywordArgument",
  );
  const rest = occurrences
    .filter((o) => o !== binding && !o.qualified && o.role !== "keywordArgument")
    .map((o) => o.range);
  const marker = binding?.range;
  return [
    ...(marker ? [{ range: marker, kind: "write" as const }] : []),
    ...rest.map((range) => ({ range, kind: "text" as const })),
  ].sort((a, b) => comparePos(a.range.start, b.range.start));
}

// ---------------------------------------------------------------------------
// Rename

/** Languages whose shorthand fields (`{ x }`, `S { x }`) name both a key and a variable. */
const SHORTHAND_LANGUAGES = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact", "rust"]);
const SHORTHAND_NODES = new Set([
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "shorthand_field_identifier",
]);

export interface RenameOccurrence {
  range: Range;
  /** `{ x }` shorthand: renaming must keep the key (`{ x: y }`). */
  shorthand: boolean;
}

export function isShorthand(at: NodeAt | null): boolean {
  if (!at) return false;
  if (SHORTHAND_NODES.has(at.node.kind)) return true;
  return at.ancestors[0]?.kind === "shorthand_field_initializer";
}

export interface LocalRenamePlan {
  symbol: LocalSymbol;
  occurrences: RenameOccurrence[];
}

export type RenamePlanResult =
  | { kind: "plan"; plan: LocalRenamePlan }
  /** Not something the syntax fallback may rename; `message` says why. */
  | { kind: "refused"; message: string }
  | { kind: "unsupported" };

/** Plans an in-file rename of the local at `pos` (definition + same-scope references). Call after `whenSynced`. */
export async function planLocalRename(
  doc: { doc: number; language: string },
  pos: Pos,
  signal?: AbortSignal,
): Promise<RenamePlanResult> {
  const support = await structure.support(doc.language);
  if (!support.locals) return { kind: "unsupported" };
  const locals = await structure.locals(doc.doc, pos, { signal });
  if (locals.status === "noIdentifier") return { kind: "refused", message: "This element can't be renamed" };
  if (locals.status === "notLocal")
    return {
      kind: "refused",
      message: tx`Can't rename '${locals.name}' based on syntax: only local variables can be renamed this way`,
    };
  const { symbol } = locals;
  const ranges = [symbol.definition, ...symbol.references].sort((a, b) => comparePos(a.start, b.start));
  const shorthand = SHORTHAND_LANGUAGES.has(doc.language)
    ? await Promise.all(ranges.map((r) => structure.nodeAt(doc.doc, r, { signal }).then(isShorthand)))
    : ranges.map(() => false);
  return {
    kind: "plan",
    plan: { symbol, occurrences: ranges.map((range, i) => ({ range, shorthand: shorthand[i]! })) },
  };
}

/** CodeMirror changes renaming every occurrence; shorthands keep their key. Null when the text no longer matches. */
export function renameChanges(doc: Text, plan: LocalRenamePlan, newName: string): ChangeSpec[] | null {
  const out: ChangeSpec[] = [];
  for (const o of plan.occurrences) {
    const { from, to } = rangeToOffsets(doc, o.range);
    if (doc.sliceString(from, to) !== plan.symbol.name) return null;
    out.push({ from, to, insert: o.shorthand ? `${plan.symbol.name}: ${newName}` : newName });
  }
  return out;
}

/** Why a syntax-based rename needs confirmation (empty: safe to apply). */
export async function renameRisks(
  doc: number,
  plan: LocalRenamePlan,
  newName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const risks: string[] = [];
  const { symbol } = plan;
  if (!symbol.certain)
    risks.push(
      `'${symbol.name}' is declared ${symbol.conflicts.length + 1} times in this scope; occurrences were assigned by position.`,
    );
  const clashes = (await structure.identifiers(doc, newName, { signal })).filter(
    (o) => !o.qualified && rangeContains(symbol.scope, o.range.start),
  );
  if (clashes.length)
    risks.push(
      `'${newName}' is already used in this scope (${clashes.length} ${clashes.length === 1 ? "occurrence" : "occurrences"}).`,
    );
  return risks;
}

export const VALID_NAME = IDENT;
