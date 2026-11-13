/**
 * Highlighting for an instance or class attribute — `self.plan_dao` in a method, and the
 * `plan_dao: PlanDao` that declares it.
 *
 * The structure service reports a member position with its name and stops there: an
 * attribute is not a local, so nothing was highlighted. What the file does say is which
 * class the accesses belong to and where the attribute is declared, and that is enough
 * for a highlight that cannot be wrong:
 *
 *   - the declaration is `name: Type` at class level, or `self.name = …` / `name = …`;
 *   - the uses are the same name inside that class body.
 *
 * A same-named attribute of a *different* class is not included, and an attribute that
 * this file never declares is not highlighted at all.
 */
import type { Range } from "@/bindings";

export interface AttributeOccurrence {
  range: Range;
  qualified: boolean;
}

export interface AttributeHighlight {
  range: Range;
  kind: "write" | "text";
}

/** The class body a line belongs to: its `class` line and the first line after the body. */
export function classBodyAt(lines: readonly string[], line: number): { head: number; end: number } | null {
  const indentOf = (l: string) => l.length - l.trimStart().length;
  let head = line;
  for (; head >= 0; head--) {
    const text = lines[head]?.trim() ?? "";
    if (!/^class\s+/.test(text)) continue;
    // Decorators above the class line belong to the class, not to its body.
    let start = head;
    while (start > 0 && /^\s*@/.test(lines[start - 1] ?? "")) start--;
    const indent = indentOf(lines[head]!);
    let end = lines.length;
    for (let i = head + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim() || l.trim().startsWith("#")) continue;
      if (indentOf(l) <= indent) {
        end = i;
        break;
      }
    }
    return start <= line && line < end ? { head: start, end } : null;
  }
  return null;
}

/**
 * The line that declares attribute `name` inside `[head, end)`, or -1.
 *
 * Python writes it as a class-level annotation (`name: Type`), an instance assignment in
 * `__init__` (`self.name = …`) or a plain assignment (`name = …`).
 */
export function declarationLineOf(lines: readonly string[], head: number, end: number, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const annotation = new RegExp(`^\\s*${escaped}\\s*:`, "u");
  const instanceAssign = new RegExp(`^\\s*self\\s*\\.\\s*${escaped}\\s*(?::[^=]+)?=`, "u");
  const plainAssign = new RegExp(`^\\s*${escaped}\\s*(?::[^=]+)?=(?!=)`, "u");
  for (let i = head + 1; i < end; i++) {
    const line = lines[i]!;
    if (annotation.test(line) || instanceAssign.test(line) || plainAssign.test(line)) return i;
  }
  return -1;
}

/**
 * Highlights for attribute `name` of the class whose body contains `line`.
 *
 * `occurrences` are every `name` token in the file (the structure service already leaves
 * out comments and string contents). Only the ones inside the class body count, and the
 * declaration is marked as the write.
 */
export function attributeHighlights(
  lines: readonly string[],
  line: number,
  name: string,
  occurrences: readonly AttributeOccurrence[],
): AttributeHighlight[] | null {
  const body = classBodyAt(lines, line);
  if (!body) return null;
  const declared = declarationLineOf(lines, body.head, body.end, name);
  if (declared < 0) return null;
  const inBody = occurrences.filter((o) => o.range.start.line > body.head && o.range.start.line < body.end);
  if (!inBody.length) return null;
  return inBody
    .map((o) => ({
      range: o.range,
      kind: (o.range.start.line === declared ? "write" : "text") as AttributeHighlight["kind"],
    }))
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.col - b.range.start.col);
}
