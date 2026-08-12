# Phase 8 — Prompts

> Read `00-INDEX.md` first. Requires Phase 7.

## Goal

Teach every prompt the repo-prefix addressing rule. Until this lands, the model keeps emitting bare
paths and leans on `resolveRepoPath`'s ambiguity fallback, which costs correction round-trips.

`src/modules/ai/lib/systemPrompts.ts` is only a re-export barrel (12 lines) — the text lives beside
each surface.

## `generator/lib/qaAnalystPrompt.ts` — SIX single-repo sites

| Line | Current text |
|---|---|
| `:12` | "Optional source-code snippets from **the user's repo** (you can read more via tools…)" |
| `:251-255` | "Use paths RELATIVE to **the user's source directory** (the working dir you were given). No absolute paths. Emit the FULL relative path EXACTLY as your Read / Glob / Grep tools reported it…" |
| `:256-259` | The codeRefs twin: "Do NOT include, assume, or invent a git branch name or commit SHA anywhere… The app stamps the actual branch + commit at publish time from **the local working directory**" |
| `:273` | `- Format per link: { "repoName": "MyApp", "filePath": "src/auth/login.cs", "symbol": … }` — the invented-repo-name example |
| `:274-275` | "`filePath` is the FULL path relative to **the source directory**, exactly as the tools reported it…" |
| `:276-278` | "Do NOT include, assume, or invent a git branch name or commit SHA — emit only the repo name, file path, and symbol. The app resolves and stamps the real branch at publish time from **the local working directory**." |

Also `:249` gives the codeRef JSON example with no repo key — keep it consistent with whatever you do
at `:273`.

**Stop asking the model for `repoName`.** It now comes from the path prefix. Leave the *field* in the
schema (Phase 9 relaxes it to optional) but remove it from the instructions and the example.

Keep the existing "never abbreviate to a bare filename" rule — it's still right, and now the full
path includes the repo prefix.

## Other prompts

- `test-plans/lib/runSuiteChat.ts:504-511` — replace `Source directory: ${sourceRoot} (use the fs
  tools to verify cases against actual code).` / `NOT SET` with a **flat, unannotated repo roster**:
  name and path only. Per the design principle in `00-INDEX.md`, do **not** describe what any repo
  is for or how it relates to the others — there is no role concept, and inventing one in prose
  would bias the model toward a topology the user may not have. It discovers relationships by
  reading.
- `test-plans/lib/runConfidenceEval.ts:312-314` — same, including the "No source directory is set —
  return Unknown with low confidence" branch, which becomes "no repos configured".
- `commit-review/commitReviewPrompts.ts` — `INVESTIGATE_SYSTEM_PROMPT` and `VERIFY_SYSTEM_PROMPT`.
- `generator/lib/qaChatRun.ts` — `CHAT_SYSTEM_PROMPT`.

## The rule to state, once, in each prompt

> Paths are `<repo>/<path-within-repo>` — e.g. `repo-one/src/services/handler.ts`. The first segment
> is always a repo name from the list above. A bare path with no repo prefix is ambiguous when
> several repos are configured. `run_command` runs inside one repo: pass `repo`, and remember that
> `git log` in one repo cannot see another.
>
> The repos above may relate to each other in any way, or not at all. Don't assume — read them.

Keep it tight — this text is on every request, so it's a permanent token cost.

## Tests

`commit-review/commitReviewPrompts.test.ts` asserts on prompt text — update in the same commit.

## Verify

1. Run a generator analyze with three repos → the activity log shows the model using prefixed paths
   from its **first** tool call, with no "path is ambiguous" corrections.
2. Same for Suite Chat and Commit Review.
3. Generated cases' `filePath` values carry a repo prefix.
4. With one repo configured, behaviour is unchanged (a bare path still resolves via the N=1
   tolerance).
5. `pnpm test` green.

## Commit

`feat(ai): teach every prompt the repo-prefixed path convention`
