/**
 * Resolve a draft bug's parent-case uid from its `linkedDraftCaseIndex`.
 *
 * `linkedDraftCaseIndex` is an index into the **full** generated `cases` array
 * — that's the invariant the review store maintains (the skip cascade,
 * `setBugDecision`, and `setBugParent` all index `cases`/`findIndex` on the
 * unfiltered array). Publishing must therefore resolve the parent through the
 * full array too. Indexing the *filtered* kept-cases array (the prior bug)
 * linked bugs to the wrong parent — or to nothing — whenever an earlier case
 * was skipped.
 */
export function bugParentCaseUid(
  linkedDraftCaseIndex: number | null | undefined,
  cases: readonly { uid: string }[],
): string | null {
  const idx = linkedDraftCaseIndex;
  if (idx === undefined || idx === null || idx < 0 || idx >= cases.length) {
    return null;
  }
  return cases[idx].uid;
}
