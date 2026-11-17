/**
 * A pandas DataFrame as a grid, opened from the Variables view.
 *
 * Shows a prefix of a large frame: `MAX_ROWS` rows by `MAX_COLS` columns, with the total
 * count in the footer, which is what PyCharm's "View as DataFrame" does as well.
 *
 * Cells can be selected and copied: a rectangle copied as TSV pastes into a spreadsheet,
 * which is what the text repr could never do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, T } from "@/ui";
import { tx } from "@/platform/i18n";
import type { DebugSessionId, Variable } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { exportExpression, MAX_ROWS, readFrameTable, type FrameTable } from "../frameTable";
import { call, commands } from "@/platform/ipc";
import styles from "./FrameTableDialog.module.css";

/** Right-aligned and monospaced when every value in the column parses as a number. */
export function numericColumns(table: Pick<FrameTable, "columns" | "rows">): boolean[] {
  return table.columns.map((_, i) => {
    let seen = false;
    for (const row of table.rows) {
      const v = row[i] ?? "";
      if (!v) continue;
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return false;
      seen = true;
    }
    return seen;
  });
}

/** A rectangle of the grid: rows and columns are 0-based cell coordinates. */
export interface Selection {
  row: number;
  col: number;
  toRow: number;
  toCol: number;
}

/** `Selection` normalised so `row <= toRow` and `col <= toCol`. */
export function normalized(sel: Selection): Selection {
  return {
    row: Math.min(sel.row, sel.toRow),
    col: Math.min(sel.col, sel.toCol),
    toRow: Math.max(sel.row, sel.toRow),
    toCol: Math.max(sel.col, sel.toCol),
  };
}

/** The selected cells as TSV: rows on lines, cells separated by tabs (a spreadsheet's paste format). */
export function selectionText(
  table: Pick<FrameTable, "rows">,
  sel: Selection,
  withHeaders?: { columns: string[] },
): string {
  const n = normalized(sel);
  const lines: string[] = [];
  if (withHeaders) lines.push(withHeaders.columns.slice(n.col, n.toCol + 1).join("\t"));
  for (let r = n.row; r <= n.toRow; r++) {
    const row = table.rows[r] ?? [];
    lines.push(row.slice(n.col, n.toCol + 1).join("\t"));
  }
  return lines.join("\n");
}

/** Whole column `col` as one value per line. */
export function columnText(table: Pick<FrameTable, "rows">, col: number): string {
  return table.rows.map((r) => r[col] ?? "").join("\n");
}

/** Whole row `row` as TSV, headed by that row's index. */
export function rowText(table: Pick<FrameTable, "rows">, row: number): string {
  return (table.rows[row] ?? []).join("\t");
}

export function FrameTableDialog({
  session,
  frameId,
  variable,
  onClose,
}: {
  session: DebugSessionId;
  frameId: number | null;
  variable: Variable;
  onClose: () => void;
}) {
  // One state for the load, keyed by what it was loaded for: a stale answer from a previous
  // page or variable must not be shown, and clearing to `null` from inside the effect would
  // re-render before the new request even started.
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    table: FrameTable | null;
    error: string | null;
  } | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [exporting, setExporting] = useState(false);
  const key = `${offset}`;
  const dragging = useRef(false);
  const current = loaded?.key === key ? loaded : null;
  const table = current?.table ?? null;
  const error = current?.error ?? null;
  const numeric = useMemo(() => (table ? numericColumns(table) : []), [table]);

  useEffect(() => {
    let live = true;
    const mine = `${offset}`;
    void readFrameTable(session, frameId, variable, offset)
      .then((t) => live && setLoaded({ key: mine, table: t, error: null }))
      .catch(
        (e: unknown) =>
          live && setLoaded({ key: mine, table: null, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [session, frameId, variable, offset]);

  const copy = useCallback((text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => notifications().notify({ level: "info", title: tx`Copied ${what}` }),
      () => notifications().notify({ level: "error", title: "Could not copy" }),
    );
  }, []);

  /**
   * Exports the whole frame on the debuggee's machine.
   *
   * The data never crosses the wire: a 50 000-row frame is ~100 MB of JSON. The debuggee
   * writes the file itself, so the path has to be reachable from there — which it is for a
   * local debugpy session, and is not for a remote one.
   */
  const exportFrame = useCallback(async () => {
    const target = variable.evaluateName?.trim() || variable.name;
    if (!target) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: tx`Export ${variable.name}`,
      defaultPath: `${variable.name}.xlsx`,
      filters: [
        { name: "Excel workbook", extensions: ["xlsx"] },
        { name: "CSV", extensions: ["csv"] },
      ],
    });
    if (!path) return;
    const format = path.toLowerCase().endsWith(".csv") ? "csv" : "xlsx";
    setExporting(true);
    try {
      await call(commands.debugEvaluate(session, frameId, exportExpression(target, path, format)));
      notifications().notify({ level: "info", title: tx`Exported to ${path}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The usual cause is a missing openpyxl, or a debuggee that cannot see this path.
      notifications().notify({ level: "error", title: tx`Export failed`, body: message });
    } finally {
      setExporting(false);
    }
  }, [session, frameId, variable]);

  // Copying inside the dialog: the browser's own copy would take the rendered text, which
  // has no tabs and loses the shape of the selection.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!table || !sel || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
    e.preventDefault();
    e.stopPropagation();
    copy(selectionText(table, sel, { columns: table.columns }), "the cells");
  };

  const startDrag = (row: number, col: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    setSel({ row, col, toRow: row, toCol: col });
  };
  const extendDrag = (row: number, col: number) => {
    if (!dragging.current) return;
    setSel((s) => (s ? { ...s, toRow: row, toCol: col } : s));
  };

  const shape = table ? `${table.rows.length} rows × ${table.columns.length} columns` : null;
  const total = table && table.totalRows !== null && table.truncated ? `${table.totalRows} rows in total` : null;
  const hasMore = table !== null && table.totalRows !== null && table.offset + table.rows.length < table.totalRows;
  const pageLabel =
    table && table.totalRows !== null
      ? `${table.offset + 1}–${table.offset + table.rows.length} / ${table.totalRows}`
      : table
        ? `${table.offset + 1}–${table.offset + table.rows.length}`
        : "";
  const inside = (r: number, c: number) => {
    if (!sel) return false;
    const n = normalized(sel);
    return r >= n.row && r <= n.toRow && c >= n.col && c <= n.toCol;
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${variable.name} {DataFrame}`}
      width={Math.min(1400, 320 + (table?.columns.length ?? 3) * 160)}
      resizable="both"
      minWidth={520}
      minHeight={280}
      buttons={[{ label: "Close", role: "default", onClick: onClose }]}
      footerStart={
        table ? (
          <div className={styles.footer}>
            <span className={styles.status}>
              {shape}
              {total ? ` — ${total}` : ""}
              {table.columnsTruncated ? ` — ${tx("Only the leading columns are shown")}` : ""}
            </span>
            <span className={styles.pager}>
              <Button
                size="small"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - MAX_ROWS));
                  setSel(null);
                }}
              >
                {tx("Previous")}
              </Button>
              <span className={styles.status}>{pageLabel}</span>
              <Button
                size="small"
                variant="ghost"
                disabled={!hasMore}
                onClick={() => {
                  setOffset(offset + MAX_ROWS);
                  setSel(null);
                }}
              >
                {tx("Next")}
              </Button>
              <Button size="small" variant="ghost" disabled={exporting} onClick={() => void exportFrame()}>
                {exporting ? tx("Exporting…") : tx("Export…")}
              </Button>
            </span>
          </div>
        ) : null
      }
    >
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !table ? (
        <div className={styles.status}>
          <T>Reading the table…</T>
        </div>
      ) : (
        <div
          className={styles.scroll}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onMouseLeave={() => (dragging.current = false)}
          onMouseUp={() => (dragging.current = false)}
        >
          <table className={styles.grid}>
            <thead>
              <tr>
                <th className={styles.gutter} scope="col" />
                {table.columns.map((c, i) => (
                  <th
                    key={`${c}-${i}`}
                    className={numeric[i] ? styles.numeric : undefined}
                    scope="col"
                    // The header picks the whole column: the usual first move when someone
                    // wants one column out of a frame.
                    onClick={() => setSel({ row: 0, col: i, toRow: table.rows.length - 1, toCol: i })}
                    // The header is the natural place for "copy this column": selecting it
                    // is the first move, and the name alone is what a query needs.
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSel({ row: 0, col: i, toRow: table.rows.length - 1, toCol: i });
                      copy(table.columns[i] ?? "", "the column name");
                    }}
                    title="Click to select the column; right-click copies its name"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  <th
                    className={styles.gutter}
                    scope="row"
                    onClick={() => setSel({ row: r, col: 0, toRow: r, toCol: table.columns.length - 1 })}
                    title="Click to select the row"
                  >
                    {r}
                  </th>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className={[numeric[c] ? styles.numeric : "", inside(r, c) ? styles.selected : ""]
                        .filter(Boolean)
                        .join(" ")}
                      title={cell}
                      onMouseDown={(e) => startDrag(r, c, e)}
                      onMouseEnter={() => extendDrag(r, c)}
                      onDoubleClick={() => copy(cell, "the cell")}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
