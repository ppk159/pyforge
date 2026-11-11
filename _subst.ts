// A parameter written inside the body cannot be substituted: the assignment
// would reach through to the caller's variable (or to an expression, which is
// not writable at all). It becomes a local of its own that starts as the
// argument, which is exactly what the callee's own variable was.
const callerFn = enclosingFunctionOf(chain);
const scope = callerFn ? spanOf(doc, callerFn) : { from: 0, to: doc.length };
const initLines: string[] = [];
for (const paramName of [...bound.keys()]) {
  if (!substitutions.has(paramName)) continue;
  const found = await structure.identifiers(ctx.doc, paramName).catch(() => []);
  let written = false;
  for (const occ of found) {
    if (occ.qualified) continue;
    const s = offsetsOf(doc, occ.range);
    if (s.from < region.from || s.to > region.to) continue;
    if (await isWriteTarget(ctx, occ.range)) {
      written = true;
      break;
    }
  }
  if (!written) continue;
  const local = await freshName(p, paramName, scope);
  if (local !== paramName) renamed.push({ from: paramName, to: local });
  substitutions.set(paramName, local);
  initLines.push(`${local} = ${bound.get(paramName)!}`);
}

// A substitution only holds where the name still means the callee's parameter or
// local: never on a write, and not inside a scope of the body's own that rebinds
// it, where the same text names something else.
const movedText = doc.sliceString(region.from, region.to);
const nests = /\b(def|class|lambda)\b/.test(movedText);
const subEdits: { from: number; to: number; insert: string }[] = [];
for (const [from, to] of substitutions) {
  const found = await structure.identifiers(ctx.doc, from).catch(() => []);
  for (const occ of found) {
    if (occ.qualified) continue;
    const s = offsetsOf(doc, occ.range);
    if (s.from < region.from || s.to > region.to) continue;
    if (nests && (await insideNestedScope(p, occ.range, fn))) {
      return `'${from}' is rebound by a scope of the declaration's own`;
    }
    subEdits.push({ from: s.from, to: s.to, insert: to });
  }
}
