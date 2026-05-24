/**
 * Curated developer-workflow prompts that the Quick Prompts strip types into
 * the terminal. The strip never submits (no trailing newline) — the user
 * always sees and edits the prompt before pressing Enter.
 *
 * Adding a prompt: append to QUICK_PROMPTS. Set `featured: true` if it
 * should appear in the always-visible chip row; others land in the overflow
 * menu. Try to keep the featured list at 4 — anything more and the strip
 * starts to feel like a toolbar instead of a starter set.
 *
 * The `command` builder receives the user's preferred AI CLI (`claude`,
 * `codex`, `aider`, …) and returns the literal characters that will be
 * piped to the PTY. Quotes inside the prompt body are intentionally
 * curly-free so they don't surprise shells that interpret smart quotes.
 */

export type QuickPromptCtx = {
  /** The CLI binary the user has set as their preferred AI tool. Empty
   *  string means "paste body raw" — see `callCli`. */
  cli: string;
  /** Resolved default base branch for the user's source dir, computed once
   *  by the strip via `git_branch_list` and a `main → master → develop`
   *  fallback. `null` when the dir isn't a git repo (or detection failed)
   *  — prompts that reference a base should phrase themselves to still
   *  read sensibly without it ("vs main" → "vs the default branch"). */
  baseBranch: string | null;
};

export type QuickPromptDef = {
  /** Stable id used for telemetry / preferences. Don't rename after release. */
  id: string;
  /** Short label rendered on the chip — keep to ~14 chars. */
  label: string;
  /** Tooltip body explaining what this chip does and what the user should
   *  do after it lands in the terminal (e.g. press Enter, edit first, etc). */
  description: string;
  /** Featured prompts appear in the always-visible chip row; the rest go
   *  in the overflow menu. */
  featured: boolean;
  /** Builds the actual string to type. The trailing space is intentional:
   *  it puts the cursor in a useful spot if the user wants to append
   *  something before submitting. */
  command: (ctx: QuickPromptCtx) => string;
};

// Wrap a prompt body in the CLI's preferred call shape. Empty CLI ⇒ paste
// just the body (lets users who don't have any AI CLI installed still get a
// useful starter line they can pipe into their own tool).
function callCli(cli: string, body: string): string {
  const trimmed = cli.trim();
  // Double-quotes around the body — single quotes don't interpolate, but
  // also don't permit embedded apostrophes in English text without escapes.
  // Internal `"` are replaced with `'` to keep the wrapper unambiguous.
  const safeBody = body.replace(/"/g, "'");
  if (!trimmed) return `${safeBody} `;
  return `${trimmed} "${safeBody}" `;
}

// Pretty-print "vs <branch>" — falls back to "vs the default branch" when
// the source dir isn't a git repo so the chip still types a coherent
// sentence. Without this every chip that mentions main on a non-git tree
// would bake "vs main" into a prompt the model would then hallucinate
// against.
function vsBase(base: string | null): string {
  return base ? `vs ${base}` : "vs the default branch";
}

export const QUICK_PROMPTS: QuickPromptDef[] = [
  {
    id: "review-diff",
    label: "Review my diff",
    description:
      "Asks the CLI to review your branch changes against the detected default branch (main / master / develop). Press Enter to run; the CLI will read your diff and flag bugs, missing tests, and security issues.",
    featured: true,
    command: ({ cli, baseBranch }) =>
      callCli(
        cli,
        `Review my changes on this branch ${vsBase(baseBranch)}. Flag bugs, missing tests, and security issues. Cite files as path:line.`,
      ),
  },
  {
    id: "add-tests",
    label: "Add tests",
    description:
      "Suggests unit tests for whichever files you most recently changed. Edit the prompt to scope it before pressing Enter.",
    featured: true,
    command: ({ cli }) =>
      callCli(
        cli,
        "Look at the recently changed files. Suggest unit tests we're missing. Show the test code.",
      ),
  },
  {
    id: "pr-description",
    label: "PR description",
    description:
      "Drafts a PR title + body from your branch's commit history and diff against the detected default branch.",
    featured: true,
    command: ({ cli, baseBranch }) =>
      callCli(
        cli,
        `Write a PR description based on my git log and diff ${vsBase(baseBranch)}. Use the conventional commit style for the title.`,
      ),
  },
  {
    id: "explain-error",
    label: "Explain error",
    description:
      "Starts a prompt for explaining a stack trace or error. Type or paste the trace after the prompt body, then press Enter.",
    featured: true,
    command: ({ cli }) =>
      callCli(cli, "Explain this error and suggest a fix:"),
  },
  {
    id: "suggest-refactors",
    label: "Suggest refactors",
    description: "Asks the CLI to read the recently changed files and suggest refactors with rationale.",
    featured: false,
    command: ({ cli }) =>
      callCli(
        cli,
        "Suggest refactors for the files I recently changed. Explain the rationale for each one.",
      ),
  },
  {
    id: "security-audit",
    label: "Security audit",
    description: "Targeted security review of your branch changes — input validation, secrets, injection, auth.",
    featured: false,
    command: ({ cli, baseBranch }) =>
      callCli(
        cli,
        `Audit my branch changes ${vsBase(baseBranch)} for security issues — input validation, secret exposure, injection, and auth holes. Cite findings as path:line with severity.`,
      ),
  },
  {
    id: "commit-message",
    label: "Commit message",
    description: "Writes a conventional-commit message for your currently-staged changes.",
    featured: false,
    command: ({ cli }) =>
      callCli(
        cli,
        "Write a conventional-commit message for my staged changes. Body should explain the why, not restate the diff.",
      ),
  },
  {
    id: "find-todos",
    label: "Find TODOs",
    description: "Scans the codebase for TODO/FIXME/HACK markers and groups them by area.",
    featured: false,
    command: ({ cli }) =>
      callCli(
        cli,
        "Find TODO / FIXME / HACK comments across the codebase. Group by area and call out anything that looks risky.",
      ),
  },
];

export const FEATURED_PROMPTS = QUICK_PROMPTS.filter((p) => p.featured);
export const OVERFLOW_PROMPTS = QUICK_PROMPTS.filter((p) => !p.featured);
