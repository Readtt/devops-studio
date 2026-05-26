import type { ExecutionOutcome } from "./types";

/** The selectable run outcomes, in ADO's order, with their display label and
 *  status-dot colour. Excludes "Active" — that's the reset / "not run" state,
 *  rendered separately by consumers. Shared by the test-case OutcomeControl
 *  and the generator review-row outcome picker so the two stay in lockstep. */
export const OUTCOMES: {
  value: Exclude<ExecutionOutcome, "Active">;
  label: string;
  dot: string;
}[] = [
  { value: "Passed", label: "Passed", dot: "bg-emerald-500" },
  { value: "Failed", label: "Failed", dot: "bg-rose-500" },
  { value: "Blocked", label: "Blocked", dot: "bg-amber-500" },
  { value: "NotApplicable", label: "Not applicable", dot: "bg-muted-foreground/60" },
];
