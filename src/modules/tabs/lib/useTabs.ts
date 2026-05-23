// Tab type union. Re-exported from the new tabs store so every consumer
// (the legacy Stacks during migration, the new pane renderer, etc.) sees
// the same shape — including the `pinned` field added in the pane upgrade.
//
// The original inline `useState<Tab[]>` lived in App.tsx; tab state now
// lives in src/modules/tabs/store/useTabsStore.ts.
export type {
  AppTab as Tab,
  TestCaseTab,
  GeneratorTab,
  BugTab,
  CodeViewerTab,
  SuiteChatTab,
} from "../store/types";
