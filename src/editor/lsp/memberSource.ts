/**
 * `obj.` member completion from what the file itself proves.
 *
 * The receiver's origin is read exactly the way Go to Declaration reads it
 * (`memberOrigin`): `x = ClassName(…)` binds a class, `from a.b import x` binds a module
 * or a name inside one. When neither applies nothing is offered — an empty list is
 * honest, a guess is not.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { OutlineItem } from "@/platform/ipc";
import { lspDoc } from "./lsp";
import { moduleNames, type ProvenMember } from "./memberCompletion";

/** `receiver.` before the caret, with an optional partial member being typed. */
export const MEMBER_TAIL = /([\p{L}_$][\p{L}\p{N}_$]*)\.([\p{L}\p{N}_$]*)$/u;

/** Where a `self.` inside a class body belongs: the class's own name. */
export function enclosingClassName(text: string, offset: number, lang: string): string | null {
  if (lang !== "python") return null;
  const lines = text.slice(0, offset).split("\n");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  // The caret usually sits just after `self.`, so its own line is the tail of what was
  // typed: measure the indentation from the line carrying that text, not from the empty
  // remainder after it.
  let here = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) {
      here = indentOf(lines[i]!);
      break;
    }
  }
  if (here < 0) return null;
  const from = lines.length - 1;
  for (let i = from; i >= 0; i--) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = indentOf(line);
    // A line deeper than the caret cannot be its enclosing scope; a decorator or the
    // caret's own line may equal it.
    if (indent > here) continue;
    if (i === from && indent === here) continue;
    const cls = /^class\s+([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(trimmed);
    if (cls) return cls[1]!;
    // Anything else at or above the caret's indentation closes the class body.
    if (!trimmed.startsWith("@")) return null;
  }
  return null;
}

/**
 * The members `receiver.` can offer, from the file alone; null when nothing is proven.
 *
 * `classMembers` resolves a class name to its members (through the index); `fileOfModule`
 * resolves an imported module to its file's outline. Both are parameters so this can be
 * tested without the backend.
 */
export async function membersFor(
  origin: { container: string | null; modules: readonly string[] },
  sources: {
    classMembers: (name: string) => Promise<ProvenMember[] | null>;
    fileOfModule: (module: string) => Promise<OutlineItem[] | null>;
  },
): Promise<ProvenMember[] | null> {
  // An imported name states its module outright, so try it first.
  for (const module of origin.modules) {
    const items = await sources.fileOfModule(module);
    if (!items) continue;
    const names = moduleNames(items);
    if (names.length) return names;
  }
  if (origin.container) return sources.classMembers(origin.container);
  return null;
}

/** Turn proven members into a CodeMirror result, filtered by what is already typed. */
export function toCompletionResult(
  members: readonly ProvenMember[],
  from: number,
  typed: string,
): CompletionResult | null {
  const prefix = typed.toLowerCase();
  const options = members
    .filter((m) => !prefix || m.name.toLowerCase().startsWith(prefix))
    .map((m) => ({
      label: m.name,
      type: m.kind === "method" || m.kind === "function" ? "method" : "property",
      // The owner is what the reader needs: which class this list came from. No
      // parameter list, because the outline carries no signature to promise.
      detail: m.owner,
    }));
  if (!options.length) return null;
  return { from, options };
}

/** Whether `ctx` sits right after `receiver.` in a file whose doc is known. */
export function memberReceiver(ctx: CompletionContext): { receiver: string; from: number; typed: string } | null {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 120), ctx.pos);
  const m = MEMBER_TAIL.exec(before);
  if (!m) return null;
  const typed = m[2]!;
  return { receiver: m[1]!, from: ctx.pos - typed.length, typed };
}

/** The doc id of the file being completed, or null outside the app. */
export const docContext = (ctx: CompletionContext) => ctx.state.facet(lspDoc);
