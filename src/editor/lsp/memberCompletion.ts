/**
 * Member completion the syntax tree can prove, for when no language server answers.
 *
 * `obj.` is completed only when this file says what `obj` is:
 *
 *   - `obj = ClassName(…)`            → the members of `ClassName`
 *   - `from a.b import obj`           → the top-level names of `a/b.py`
 *   - `from a.b import obj` where `obj` is itself a module → that module's names
 *
 * Anything else — a parameter, a call result, a list element — says nothing about the
 * members, and a guess would be worse than an empty list. That is the point of this
 * build: it does not invent types.
 *
 * The members come from `doc_outline`, which the structure service already computes for
 * the Structure tool window: a class node's children are its members.
 */
import type { OutlineItem } from "@/platform/ipc";
import { commands, call } from "@/platform/ipc";
import { withDocument } from "./files";

export interface ProvenMember {
  name: string;
  /** The outline's own kind (`method`, `field`, `class`…), for the lookup icon. */
  kind: string;
  /** The class or module the member was read from, shown as the type column. */
  owner: string;
}

/** Every name the file defines, with each class's members among them. */
export function namesInOutline(items: readonly OutlineItem[]): ProvenMember[] {
  const out: ProvenMember[] = [];
  const walk = (node: OutlineItem, owner: string) => {
    if (node.name) out.push({ name: node.name, kind: node.kind, owner });
    for (const child of node.children ?? []) walk(child, node.name || owner);
  };
  for (const item of items) walk(item, item.name);
  return out;
}

/** The members of class `name` in `items`; null when that file has no such class. */
export function membersOfClass(items: readonly OutlineItem[], name: string): ProvenMember[] | null {
  const find = (list: readonly OutlineItem[]): OutlineItem | null => {
    for (const item of list) {
      if (item.name === name && (item.kind === "class" || item.kind === "interface" || item.kind === "struct"))
        return item;
      const deeper = find(item.children ?? []);
      if (deeper) return deeper;
    }
    return null;
  };
  const cls = find(items);
  if (!cls) return null;
  const out: ProvenMember[] = [];
  for (const child of cls.children ?? []) if (child.name) out.push({ name: child.name, kind: child.kind, owner: name });
  return out;
}

/**
 * Outlines of files other than the edited one, keyed by path.
 *
 * Reading one costs ~50 ms (open, parse, close), which is fine once and far too slow
 * per keystroke — completion runs on every character. A file on disk only changes when
 * something writes it, and a stale member list is a cosmetic problem, not a wrong
 * answer, so the entry is dropped on the next edit to that path rather than watched.
 */
const outlines = new Map<string, OutlineItem[] | null>();

/** A file's outline, or null when it cannot be opened or parsed. */
export async function outlineOf(path: string): Promise<OutlineItem[] | null> {
  const cached = outlines.get(path);
  if (cached !== undefined) return cached;
  try {
    const items = await withDocument(path, (doc) => call(commands.docOutline(doc)));
    outlines.set(path, items);
    return items;
  } catch {
    outlines.set(path, null);
    return null;
  }
}

/** Forget a cached outline (a file changed on disk, or a refactoring rewrote it). */
export function forgetOutline(path: string): void {
  outlines.delete(path);
}

/**
 * Whether `items` looks like a module rather than a class definition: no class whose
 * name matches the file. Used to pick "the names a module exports" over "the members
 * of a class" when a receiver is an imported module.
 */
export function moduleNames(items: readonly OutlineItem[]): ProvenMember[] {
  return namesInOutline(items);
}
