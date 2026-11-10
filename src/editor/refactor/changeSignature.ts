/**
 * Change Signature (⌃F6) without the language server.
 *
 * v1 covers the one edit whose correctness is provable from the syntax alone and
 * that never breaks an existing call site: **append a parameter that has a
 * default**. Every existing call still binds the same parameters, so no call
 * site changes; only the signature grows.
 *
 *     def f(a, b):            def f(a, b, c=0):
 *         ...                     ...
 *
 * Everything a wider implementation must do changes what a call site means —
 * reordering, removing, renaming a parameter callers pass positionally, adding
 * one without a default — so it is refused rather than guessed. IDEA offers all
 * of it; the syntax-only path deliberately does not.
 */
import type { ChangeSet, EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { structure } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { spanOf, type Span } from "./analysis";
import { tx } from "@/platform/i18n";

/** Languages this syntax-only implementation covers. */
const LANGUAGES = new Set(["python"]);

/** The signature the change produces, plus the edit that gets there. */
export interface AppendPlan {
  /** The `def …` line, up to (not including) the `:`. */
  from: number;
  to: number;
  /** The new signature line, without the colon. */
  text: string;
  /** The new parameter, for the confirmation and for tests. */
  parameter: string;
}

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
  doc: Text;
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
 * Commas inside brackets (a default `f(a, b)` or a `dict`) do not split, so the
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
  if (/^\*/.test(name)) return "a starred parameter cannot be appended this way";

  const items = parameterItems(signature);
  if (typeof items === "string") return items;
  if (items.some((item) => item.text.startsWith("*"))) return "the declaration takes *args or **kwargs";
  if (items.some((item) => paramName(item) === name)) return `the declaration already has a parameter '${name}'`;

  const parameter = `${name}=${defaultValue}`;
  if (!items.length) {
    // `def f():` → `def f(name=default):`
    const open = signature.indexOf("(");
    const close = signature.indexOf(")", open);
    return { text: `${signature.slice(0, open + 1)}${parameter}${signature.slice(close)}`, parameter };
  }
  // Append after the last parameter, which keeps every existing binding intact.
  const last = items[items.length - 1]!;
  return { text: `${signature.slice(0, last.to)}, ${parameter}${signature.slice(last.to)}`, parameter };
}

/** The `def …` line's offsets (up to the `:`) and its text, for the node at `pos`. */
export async function signatureAt(p: Prepared, pos: number): Promise<{ span: Span; text: string } | string> {
  const node = await structure.nodeAt(p.ctx.doc, offsetsToRange(p.doc, pos, pos)).catch(() => null);
  if (!node) return "the declaration could not be read";
  const fn = [node.node, ...node.ancestors].find((n) => n.kind === "function_definition");
  if (!fn) return "place the caret on a function declaration";
  const fnSpan = spanOf(p.doc, fn);
  const text = p.doc.sliceString(fnSpan.from, fnSpan.to);

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
  return { span: { from: fnSpan.from, to: fnSpan.from + colon }, text: text.slice(0, colon) };
}

/**
 * Everything that can make the change unsafe is checked before any edit.
 * Returns the reason instead of a plan when it cannot be done.
 */
export async function planAppendParameter(view: EditorView, name: string, def: string): Promise<AppendPlan | string> {
  const ctx = docOf(view);
  if (!ctx) return "no document";
  if (!LANGUAGES.has(ctx.language)) return "Change Signature needs the language server for this language";
  await whenSynced(view);
  const doc = view.state.doc;
  const p: Prepared = { view, ctx, doc };

  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return "Change Signature needs the language server here";

  const sel = view.state.selection.main;
  const signature = await signatureAt(p, sel.from);
  if (typeof signature === "string") return signature;

  const made = appendParameter(signature.text, name, def);
  if (typeof made === "string") return made;
  return { from: signature.span.from, to: signature.span.to, text: made.text, parameter: made.parameter };
}

function changesFor(plan: AppendPlan, state: EditorState): ChangeSet {
  return state.changes([{ from: plan.from, to: plan.to, insert: plan.text }]);
}

/**
 * Appends the parameter. Returns whether the document changed, like the other
 * fallbacks, so the caller can tell a refusal from a no-op.
 */
export async function appendParameterFallback(view: EditorView, name: string, def: string): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  if (ctx.readOnly) return refuse(view, "the file is read-only");
  const before = view.state.doc;
  try {
    const planned = await planAppendParameter(view, name, def);
    if (typeof planned === "string") return refuse(view, planned);
    if (view.state.doc !== before) {
      showHint(view, tx`The document changed; invoke the refactoring again`);
      return true;
    }
    const changes = changesFor(planned, view.state);
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(planned.to, 1) },
      scrollIntoView: true,
      userEvent: "refactor.changeSignature",
    });
    view.focus();
    return view.state.doc !== before;
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "AbortError") console.debug("[refactor]", e);
    return view.state.doc !== before;
  }
}
