/**
 * The refusal docs under `docs/` quote every message the implementation can
 * return. A message that changes without the doc failing here means the doc is
 * lying to the reader.
 *
 * Fixed messages are matched verbatim. Templated ones are documented with their
 * interpolations filled in (`'x' is reassigned; …`), so the surrounding text is
 * matched instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Case {
  source: string;
  doc: string;
}

const CASES: Case[] = [
  { source: "src/editor/refactor/extractMethod.ts", doc: "docs/extract-method-python.md" },
  { source: "src/editor/refactor/inline.ts", doc: "docs/inline-variable-python.md" },
  { source: "src/editor/refactor/inlineFunction.ts", doc: "docs/inline-method-python.md" },
  { source: "src/editor/refactor/changeSignature.ts", doc: "docs/change-signature-python.md" },
  { source: "src/editor/refactor/move.ts", doc: "docs/move-python.md" },
  { source: "src/editor/refactor/loops.ts", doc: "docs/loops-python.md" },
];

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/** Fixed messages: `return "the selection …"`. */
function fixedMessages(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/return "([^"]{20,})"/g)) {
    const message = m[1]!;
    // Only user-facing refusals; skip internal identifiers.
    if (/^(no document|the |place |Inline |Extract )/.test(message)) out.add(message);
  }
  return [...out];
}

/**
 * Templated messages: keep the literal head and tail around the interpolations,
 * because the doc shows the message with a concrete name filled in.
 */
function templateParts(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/return `([^`]{20,})`/g)) {
    const body = m[1]!;
    // Drop template-only strings (they build code, not messages).
    if (body.includes("(\\$\\{plan.") || /\bdef |\n/.test(body)) continue;
    const parts = body
      .split(/\$\{[^}]*\}/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 12);
    out.push(...parts);
  }
  return out;
}

describe.each(CASES)("$doc", ({ source, doc }) => {
  const text = read(source);
  const page = read(doc);

  it("documents every fixed refusal message", () => {
    const messages = fixedMessages(text);
    // The module does have user-facing refusals; a regex that silently matched
    // nothing would otherwise pass.
    expect(messages.length).toBeGreaterThan(3);
    for (const message of messages) {
      expect(page, `missing from ${doc}: ${message}`).toContain(message);
    }
  });

  it("documents every templated refusal message", () => {
    const parts = templateParts(text);
    // Not every module has a templated refusal (`changeSignature.ts` has two), so
    // no minimum here: the loop is the assertion.
    for (const part of parts) {
      expect(page, `missing from ${doc}: ${part}`).toContain(part);
    }
  });
});
