export { useSourceDirGitInfo } from "./useSourceDirGitInfo";
export type { GitRepoInfo } from "./useSourceDirGitInfo";
export { useSourceDirStatus } from "./useSourceDirStatus";
export {
  CURRENT_BRANCH_SENTINEL,
  resolveTrackingBranch,
} from "./trackingBranch";
export {
  EMPTY_STATUS,
  SOURCE_GIT_CHANGED_EVENT,
  emitSourceGitChanged,
  gitStatusSummary,
  gitBranches,
  gitCheckout,
  gitPull,
  gitFetch,
  gitStashRestore,
} from "./gitOps";
export type {
  GitStatusSummary,
  GitCheckoutResult,
  GitPullResult,
  GitFetchResult,
  GitStashRestoreResult,
  BranchListItem,
  CheckoutMode,
} from "./gitOps";
export { useBranchSwitch } from "./useBranchSwitch";
export { StatusBarGit } from "./StatusBarGit";
export { BranchSwitchToast } from "./BranchSwitchToast";
export { BranchSwitchDialog } from "./BranchSwitchDialog";
