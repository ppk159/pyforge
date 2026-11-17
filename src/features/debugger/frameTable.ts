/**
 * A pandas DataFrame shown as a table instead of its `repr`.
 *
 * The debugger receives `Variable.value`, a string already truncated by pandas'
 * `display.max_rows` / `display.max_columns` — the middle of a large frame is gone before
 * the IDE sees it. PyCharm avoids that by asking the debuggee for the data itself; this
 * does the same: `evaluate` an expression that serialises the frame to JSON, then render
 * the JSON as a grid.
 *
 * Two hard limits keep the cost predictable: a frame of 540 rows costs ~100 KB of JSON and
 * < 1% of the window's memory, while an unbounded 50 000 × 100 frame would be ~300 MB. The
 * same limits apply in PyCharm, which also shows a prefix and offers more on request.
 */
import { commands, type DebugSessionId, type Variable } from "@/platform/ipc";
import { call } from "@/platform/ipc";

/** Rows serialised in one request. Beyond this the table shows a prefix. */
export const MAX_ROWS = 200;
/** Columns serialised in one request. */
export const MAX_COLS = 100;
/** Cells are formatted on the debuggee's side; a JSON of this size is refused rather than parsed. */
const MAX_JSON_CHARS = 4_000_000;

export interface FrameTable {
  columns: string[];
  rows: string[][];
  /** Row number of the first row in `rows` (paging). */
  offset: number;
  /** Rows the frame has in total, when the debuggee reported it. */
  totalRows: number | null;
  /** The table is a prefix of a larger frame. */
  truncated: boolean;
  /** Values were dropped because the frame has more than `MAX_COLS` columns. */
  columnsTruncated: boolean;
}

/** The type names a pandas DataFrame reports through DAP. */
export function isDataFrame(v: Pick<Variable, "typeName" | "value">): boolean {
  const t = v.typeName?.toLowerCase() ?? "";
  if (t.includes("dataframe")) return true;
  // Some debuggers report `object` and only mention the class in the value's repr.
  return /^\s*\w*\s*DataFrame\b/.test(v.value) || /<class 'pandas\.core\.frame\.DataFrame'>/.test(v.value);
}

/**
 * The expression sent to the debuggee.
 *
 * Not `DataFrame.to_json`: it has no way to stringify a `Timestamp` or a `Decimal`, and it
 * writes `NaN` where JSON needs `null` — the payload would not parse. Going through
 * `astype(object).where(notna, None)` turns missing values into real `None`, and
 * `json.dumps(default=str)` handles every dtype pandas can hold. `iloc` bounds the slice,
 * so a non-unique index cannot duplicate keys.
 *
 * The result is a `str`, which the debugger reports with quotes around it.
 */
export function tableExpression(target: string, offset = 0, rows = MAX_ROWS, cols = MAX_COLS): string {
  const end = offset + rows;
  return (
    "__import__('json').dumps(" +
    `__import__('pandas').DataFrame(${target}).iloc[${offset}:${end}, :${cols}]` +
    ".astype(object).where(lambda _c: _c.notna(), None).to_dict(orient='split'), " +
    "default=str, ensure_ascii=False)"
  );
}

/**
 * The expression that writes the whole frame to a file, on the debuggee's machine.
 *
 * Export has to run there: the data never crosses the wire in full, which is the point —
 * a 50 000-row frame is ~100 MB of JSON and would not survive the trip. `to_excel` needs
 * openpyxl; when it is missing the error comes back as the evaluate result.
 *
 * `index=False` because the row numbers are the grid's, not the frame's.
 */
export function exportExpression(target: string, path: string, format: "csv" | "xlsx"): string {
  const literal = JSON.stringify(path);
  const call =
    format === "xlsx" ? `to_excel(${literal}, index=False)` : `to_csv(${literal}, index=False, encoding='utf-8-sig')`;
  return `(__import__('pandas').DataFrame(${target}).${call}, True)[1]`;
}

/** Rows in the whole frame, for the "showing 200 of 540" line. */
export function shapeExpression(target: string): string {
  return `__import__('json').dumps(list(__import__('pandas').DataFrame(${target}).shape))`;
}

/** `DataFrame.to_dict(orient="split")`: `columns` are the column labels, `data` the rows. */
interface SplitJson {
  columns?: unknown;
  data?: unknown;
}

/**
 * `to_json(orient="split")` output as a table; null when it is not that shape.
 *
 * Deeper rows are flattened to one line each: a cell holding a list or a dict has no
 * meaning split across grid rows.
 */
export function parseSplit(
  json: string,
): Omit<FrameTable, "totalRows" | "truncated" | "columnsTruncated" | "offset"> | null {
  let parsed: SplitJson;
  try {
    parsed = JSON.parse(json) as SplitJson;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.data)) return null;
  const columns = parsed.columns.map((c) => String(c));
  const rows = parsed.data.map((row) => {
    if (!Array.isArray(row)) return columns.map(() => "");
    return columns.map((_, i) => cellText(row[i]));
  });
  return { columns, rows };
}

/** One cell as the single line a grid row can hold. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The table for `variable`, read from the debuggee.
 *
 * A frame that is not a pandas one (a numpy array, a list of dicts) evaluates to an error
 * on the debuggee side; the caller shows that instead of an empty grid.
 */
export async function readFrameTable(
  session: DebugSessionId,
  frameId: number | null,
  variable: Pick<Variable, "name" | "evaluateName" | "value">,
  offset = 0,
): Promise<FrameTable> {
  const target = variable.evaluateName?.trim() || variable.name;
  if (!target) throw new Error("this variable has no expression to read");
  const [data, shape] = await Promise.all([
    evaluate(session, frameId, tableExpression(target, offset)),
    evaluate(session, frameId, shapeExpression(target)).catch(() => null),
  ]);
  if (data.value.length > MAX_JSON_CHARS) throw new Error("the frame is too large to show");
  const table = parseSplit(unquote(data.value));
  if (!table) throw new Error("the debuggee did not return a table");
  const total = shape ? parseShape(unquote(shape.value)) : null;
  return {
    ...table,
    offset,
    totalRows: total?.[0] ?? null,
    truncated: (total?.[0] ?? table.rows.length) > table.rows.length,
    columnsTruncated: (total?.[1] ?? table.columns.length) > table.columns.length,
  };
}

async function evaluate(session: DebugSessionId, frameId: number | null, expression: string): Promise<Variable> {
  return call(commands.debugEvaluate(session, frameId, expression));
}

/**
 * A JSON string as the debugger reports it: the value of a Python `str`, quoted and with
 * Python's escapes.
 *
 * Scanned rather than `JSON.parse`d: Python writes `\'` inside a single-quoted result,
 * which is not a JSON escape, and wrapping the body in double quotes to reuse `JSON.parse`
 * needs a lookbehind to tell a real quote from an escaped one — a regex feature this
 * app cannot use (see `webkitCompatibility.test.ts`).
 */
export function unquote(value: string): string {
  const t = value.trim();
  if (t.length < 2) return t;
  const quote = t[0];
  if ((quote !== "'" && quote !== '"') || t[t.length - 1] !== quote) return t;
  return unescapePython(t.slice(1, -1));
}

/** Undoes the escapes a Python `repr` puts in a string; anything unknown is kept as written. */
function unescapePython(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== BACKSLASH || i + 1 >= body.length) {
      out += ch;
      continue;
    }
    const next = body[++i]!;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        out += "\u0000";
        break;
      case BACKSLASH:
      case "'":
      case '"':
        out += next;
        break;
      default:
        out += BACKSLASH + next;
    }
  }
  return out;
}

/** Named so the source has no escape sequence for a backslash literal. */
const BACKSLASH = String.fromCharCode(92);

/** `[rows, columns]` from `shapeExpression`. */
export function parseShape(json: string): [number, number] | null {
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
  } catch {
    /* not shape output */
  }
  return null;
}
