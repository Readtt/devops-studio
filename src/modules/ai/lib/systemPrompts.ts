// One place to find every surface's base system prompt. The prompts themselves
// still live next to the surface that owns them (so the prompt and the parsing
// logic it implies stay together); this module is the single import point the
// task runner's callers reach for. No content unification — these are the
// existing prompts, surfaced under stable names.

export { QA_ANALYST_PROMPT as qaAnalyst } from "@/modules/generator/lib/qaAnalystPrompt";
export { SUITE_CHAT_SYSTEM_PROMPT as suiteChat } from "@/modules/test-plans/lib/runSuiteChat";
export { INVESTIGATE_SYSTEM_PROMPT as commitReview } from "@/modules/commit-review/commitReviewPrompts";
export { VERIFY_SYSTEM_PROMPT as commitReviewVerify } from "@/modules/commit-review/commitReviewPrompts";
export { CONFIDENCE_EVAL_SYSTEM_PROMPT as confidenceEval } from "@/modules/test-plans/lib/confidenceEvalPrompt";
export { CHAT_SYSTEM_PROMPT as draftChat } from "@/modules/generator/lib/qaChatRun";
