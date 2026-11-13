/**
 * Documentation for a symbol the structure service can locate, for when no language
 * server answers.
 *
 * Python puts it in a string literal as the first statement of the definition's body;
 * this reads that literal and renders it as markdown. Everything here is derived from
 * the definition's own text — a docstring that is computed at run time (assigned,
 * concatenated, formatted) is not documentation, and is left alone rather than shown
 * half-evaluated.
 */

/** Quote sequences that open a Python string literal, longest first. */
const QUOTES = ['"""', "'''", '"', "'"] as const;

/** Index just past the opening quote of a literal that starts on `line`, or -1. */
function openingQuoteAt(line: string): { quote: string; rest: number } | null {
  const first = line.trimStart();
  // String prefixes: r, b, u, f, and combinations such as rb / f.
  const prefix = /^[rRbBuUfF]{0,2}/.exec(first)![0];
  const after = first.slice(prefix.length);
  for (const quote of QUOTES) {
    if (after.startsWith(quote)) {
      const column = line.length - first.length + prefix.length + quote.length;
      return { quote, rest: column };
    }
  }
  return null;
}

/** A CRLF file keeps a trailing CR on every line; a docstring must not carry it. */
const stripCr = (line: string) => (line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line);

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * The docstring of a definition whose header is `headerLine` (0-based), or null when
 * the definition has none.
 *
 * `indent` is the definition's own indentation: a body statement sits deeper, and a
 * line at or above that indentation ends the body. That check is what stops the search
 * from borrowing the next function's docstring — in a class every method has one, so a
 * wrong answer here shows unrelated documentation.
 */
export function docstringAfter(lines: readonly string[], headerLine: number, indent: number): string | null {
  let i = headerLine + 1;
  while (i < lines.length) {
    const text = stripCr(lines[i]!).trim();
    if (!text) {
      i++;
      continue;
    }
    if (indentOf(lines[i]!) <= indent) return null;
    // A comment may sit between the header and the docstring.
    if (text.startsWith("#")) {
      i++;
      continue;
    }
    break;
  }
  if (i >= lines.length) return null;

  const first = stripCr(lines[i]!);
  const open = openingQuoteAt(first);
  if (!open) return null;
  const { quote } = open;
  const body = first.slice(open.rest);

  // Closing quotes on the same line: a one-line docstring.
  const close = body.indexOf(quote);
  if (close >= 0) return clean(body.slice(0, close));
  // A single quote that does not close on its own line is not a docstring opener.
  if (quote.length === 1) return null;

  const parts: string[] = [body];
  for (let j = i + 1; j < lines.length; j++) {
    const line = stripCr(lines[j]!);
    const end = line.indexOf(quote);
    if (end >= 0) {
      parts.push(line.slice(0, end));
      return clean(parts.join("\n"));
    }
    parts.push(line);
  }
  return null;
}

/**
 * The literal's text as markdown: escape sequences resolved, then the common leading
 * indentation removed so the tooltip does not render a staircase.
 */
function clean(body: string): string | null {
  const text = body
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map(indentOf);
  const common = indents.length ? Math.min(...indents) : 0;
  const result = lines
    .map((l) => l.slice(Math.min(common, indentOf(l))).trimEnd())
    .join("\n")
    .trim();
  return result || null;
}
