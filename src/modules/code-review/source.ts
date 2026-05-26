// What a Code Review tab is reviewing. Absent/null ⇒ the local working-copy
// diff (git_diff). Set ⇒ a diff pulled from Azure DevOps. Kept in its own
// module so the tab store can reference the type without importing the
// code-review runtime.

export type CodeReviewSource = {
  kind: "ado";
  repoId: string;
  repoName: string;
  /** Which ADO unit to diff. */
  unit: "commit" | "pr" | "branch";
  /** unit === "commit" */
  commitId?: string;
  /** unit === "pr" */
  prId?: number;
  /** unit === "branch" */
  baseBranch?: string;
  targetBranch?: string;
};

/** A short human label for the chosen source (tab title / header chip). */
export function describeSource(source: CodeReviewSource | null): string {
  if (!source) return "Local";
  switch (source.unit) {
    case "commit":
      return `${source.repoName} · ${(source.commitId ?? "").slice(0, 8)}`;
    case "pr":
      return `${source.repoName} · PR #${source.prId}`;
    case "branch":
      return `${source.repoName} · ${source.baseBranch}…${source.targetBranch}`;
  }
}
