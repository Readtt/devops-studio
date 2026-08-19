/**
 * Sentinel persisted in ADO `defaultTrackingBranch`, and the only value ever
 * written there: a published code link tracks the live branch of the repo it
 * names, resolved per repo at publish time (`useGenerationSession`). There is
 * no fixed-branch option, so nothing resolves this sentinel to a branch — it
 * exists to keep the stored preference readable and to let a legacy fixed
 * value be recognised as legacy.
 */
export const CURRENT_BRANCH_SENTINEL = "$current";
