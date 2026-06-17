// Pure line-range helpers shared by ApplyPatchCard's preview ("before" side)
// and its on-disk apply ("after" side). They MUST agree on how a line range
// maps to text — the diff the user previews has to equal what gets written —
// so they live together here and are covered by lineSplice.test.ts.

/** Splice lines [startLine, endLine] (1-indexed, inclusive) with the
 *  replacement text. For pure-insert patches, the caller passes
 *  endLine < startLine so the slice is empty. Newlines are preserved,
 *  including the file's terminating newline when the edit reaches EOF. */
export function spliceLines(
  source: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const lines = source.split("\n");
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = endLine < startLine ? startIdx : Math.min(lines.length, endLine);
  // Splice the array and re-join once. Reconstructing via truthiness-gated
  // before/after parts dropped an empty trailing segment, which silently
  // stripped the file's terminating newline (or genuine trailing blank lines)
  // whenever the edit reached EOF. Splicing preserves every segment and keeps
  // this consistent with sliceLinesText's unconditional join.
  lines.splice(startIdx, endIdx - startIdx, ...replacement.split("\n"));
  return lines.join("\n");
}

/** The file's lines [startLine, endLine] (1-indexed, inclusive) as text — the
 *  "before" side of the diff. For an insert (endLine < startLine) the slice is
 *  empty, so the diff renders as all-added. */
export function sliceLinesText(
  source: string,
  startLine: number,
  endLine: number,
): string {
  const lines = source.split("\n");
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = endLine < startLine ? startIdx : Math.min(lines.length, endLine);
  return lines.slice(startIdx, endIdx).join("\n");
}
