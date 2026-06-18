/**
 * Sentinel value persisted in ADO `defaultTrackingBranch` that means
 * "resolve at scan/index time from the user's source directory git branch".
 */
export const CURRENT_BRANCH_SENTINEL = "$current";

/**
 * Resolve the effective tracking branch to use right now.
 *
 * - `$current` sentinel → uses the source-dir branch if available, else falls
 *   back to "main" (so a never-resolved scan still has *something* to track).
 * - Anything else → returned verbatim (trimmed), with "main" as last resort.
 */
export function resolveTrackingBranch(
  saved: string | null | undefined,
  sourceDirBranch: string | null | undefined,
): string {
  const s = (saved ?? "").trim();
  if (s === CURRENT_BRANCH_SENTINEL) {
    return (sourceDirBranch ?? "").trim() || "main";
  }
  return s || "main";
}
