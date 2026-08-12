# Phase 7 — The AI tool layer  ← the core fix

> Read `00-INDEX.md` first — especially **AI addressing: repo-prefixed virtual paths**, which
> specifies `resolveRepoPath` in full. Requires Phases 3–6.

**This is the phase that solves the reported problem.** After it, every AI surface reads every
configured repo. It also fixes **bug #5** — the tool layer currently has no path containment at all.

**It must land as a single commit**: the factory, its five callers, the checkpoint payloads, and
seven test files change together or nothing compiles.

## 1. New file: `src/modules/ai/lib/repoPaths.ts`

Implement `resolveRepoPath` exactly as specified in `00-INDEX.md`. This is the single containment
point for the whole app.

Two things that will bite:

- **`fs_stat` rejects on a missing path** (`fs/file.rs:208` → `Err(String)` → the promise rejects).
  It does not return null. Every probe needs `.catch(() => null)`. Precedent:
  `BestPracticesSection.tsx:75`.
- **`fs_stat` follows symlinks**, so `kind: "symlink"` is effectively unreachable (`file.rs:211`).
  Don't branch on it.

`checkReadable` (`security.ts:198`) is the last gate. It has **four** checks, not two: empty/non-string
(`:199-206`), control bytes, 21 secret basename patterns (`:31-59`), 25 protected dirs (`:66-98`).

## 2. Rewrite `buildSuiteChatTools`

**File:** `src/modules/test-plans/lib/suiteChatTools.ts`

```ts
buildSuiteChatTools(sourceRoot: string | null)   // :59, with `const root = sourceRoot` at :61
→ buildSuiteChatTools(repos: WorkspaceRepo[])
```

Return `undefined` on an empty list — that preserves the tool-less path at `qaAnalystRun.ts:339`
(`tools ? streamTask : runTask`).

| Tool | Line | Change |
|---|---|---|
| `read_file` | `:64` | `resolvePathHint` (`:502`) → `resolveRepoPath`. On `{ok:false}` return the reason **as the tool result** — the model self-corrects. Echo `corrected` when a prefix was inferred. |
| `list_files` | `:130` | No `subpath` → fan out `fs_list_files` across all repos at `ceil(limit / N)` each, prefixing every entry. With a prefix → resolve to one repo. At N=1 this is exactly today's behaviour. |
| `grep` | `:172` | No path → fan out `fs_grep` across repos in parallel, then **round-robin interleave** before truncating to `maxResults`. Straight concatenation lets one repo's 80 hits hide another entirely. Same for `filesOnly` scans and `FILES_ONLY_SCAN_CAP` (`:54`). Prefix every result path. |
| `run_command` | `:257` | Gains an **optional** `repo` param — a cwd needs exactly one root. Omitted + N=1 → that repo. Omitted + N>1 → error listing repo names. |

Current `run_command` schema is `{ command: z.string().min(1) }` only (`:260-267`), executing
`invoke("run_readonly_command_cmd", { root, command })` at `:274`. Rust has **no** repo concept
(`command.rs:368`), so `repo` is resolved entirely frontend-side into `root`. Keep `repo`
**optional** — a required param breaks the test map (below).

`git log` in one repo genuinely cannot see another. Say so in the prompt (Phase 8), not in code.

Other existing params, for reference: `read_file` takes `path` / `offset` / `limit`; `list_files`
takes `subpath` / `limit`; `grep` takes `pattern` / `glob` / `caseInsensitive` / `maxResults` /
`filesOnly`.

- `emptyScanHint` (`:464`) hard-codes single-root glob reasoning — rewrite for the repo prefix.
- **Do not touch the result caps.** `TOOL_RESULT_CAP = 50_000` (`:33`),
  `MESSAGE_RESULT_CAP = 200_000` (`:43`), `READ_LINE_CAP` / `READ_BYTE_CAP` (`:25-26`),
  `GREP_LINE_CAP` (`:48`), enforced by `withResultCaps` (`:340`). A fan-out is still one merged
  result — that's the point.
- **Do not multiply `SURFACE_STEP_CAPS` / `SURFACE_TOKEN_BUDGETS`** (`ai/config.ts:852-887`). N repos
  means more exploration per step, not more budget. Per-run scope (Phases 9–11) is the control.

## 3. All five callers — same commit

Each swaps `sourceRoot: string | null` for `repos: WorkspaceRepo[]`, populated at this stage with
**every** configured repo (still gated by `codeSearchEnabled`). Per-run scope chips arrive in
Phases 9–11.

| Caller | Field to change |
|---|---|
| `generator/lib/qaAnalystRun.ts:299` | `RunInput.sourceRoot` (`:167`), `PreparedAnalystRun.sourceRoot` (`:236`) |
| `generator/lib/qaChatRun.ts:165` | `ChatRunInput.sourceRoot` (`:131`) |
| `test-plans/lib/runSuiteChat.ts:425` | `SuiteChatInput.sourceRoot` (`:405-408`) |
| `test-plans/lib/runConfidenceEval.ts:260` | `ConfidenceEvalInput.sourceRoot` (`:51`) |
| `commit-review/runCommitReview.ts:159` | `CommitReviewInput.sourceRoot` (`:83`) |

Feeders to update alongside: `useGenerationSession.ts:1862` (analyze), `:3061` (refine), `:3585`
(chat); `useSuiteChat.ts:831, :886`; `useCommitReview.ts:1182`; `evaluateCaseConfidence.ts:34`.

## 4. Checkpoint payloads — also this commit, not later

They mirror these run inputs. Splitting them would leave a window where a resumed run restores one
root while the live path reads many.

In `src/modules/ai/lib/checkpointApi.ts`:
- `GeneratorCheckpointV1.sourceRoot` (`:89`) → `repos: WorkspaceRepo[]`
- `GeneratorRefineCheckpointV1.sourceRoot` (`:139`) → same
- `CommitReviewCheckpointV1.sourceRoot` (`:167`) → same
- `CHECKPOINT_PAYLOAD_VERSION` (`:189`) `1` → `2`. That's the whole version change —
  `isValidEnvelope` (`:303-312`) already reads the constant.

`CommitReviewCheckpointV1.cwd` is a **separate** field. Leave it alone; Phase 10 changes what goes in
it, which is not a shape change and needs no second bump.

`resumeAnalyze` (`useGenerationSession.ts:2149`) restores `repos` from the payload, **never** from
live prefs — a resumed run must use the repos it started with.

**v1 rows need no migration and no prune.** Verified: `parseCheckpointRow` returns `null` on a
version mismatch, `getCheckpoint` is the only payload reader, and every consumer —
`loadInterruptedRuns` (`GenerationHistoryPane.tsx:80-86`), `adoptInterruptedRun`,
`probeRefineCheckpoint` — already skips nulls. Stale rows age out under keep-10-per-surface.

## 5. Tests that break — update in this commit

- Four `vi.mock` stubs hard-coding the 1-arg factory shape: `qaAnalystRun.test.ts:16`,
  `qaChatRun.test.ts:13`, `runConfidenceEval.cachePrefix.test.ts:13`,
  `runConfidenceEval.runs.test.ts:13`, `runSuiteChat.test.ts:10`.
- `suiteChatTools.test.ts:217-222` — a `TOOL_ARGS` map enumerating every tool's args, consumed by the
  "every tool is capped" test at `:257-274`:
  ```ts
  const TOOL_ARGS: Record<string, unknown> = {
    read_file: { path: "a.ts" }, list_files: {},
    grep: { pattern: "NEEDLE" }, run_command: { command: "git log" },
  };
  ```
  Keeping `repo` optional means these args stay valid — but the suite still needs a `repos` fixture
  in place of the old root string.

**New:** `src/modules/ai/lib/repoPaths.test.ts` covering absolute-in-repo, absolute-outside (reject),
prefixed, bare-with-one-repo, bare-ambiguous (reject naming candidates), bare-unique-probe,
`..` traversal (reject), secret basename (reject), and an `fs_stat` rejection handled without
throwing.

## Verify

1. Three repos configured, code search on. Run a generator analyze → the activity log shows reads in
   **more than one** repo. That's the acceptance signal for this phase.
2. Ask Suite Chat to grep for a symbol that exists in two repos → results from both, interleaved, not
   all from one.
3. `run_command` with no `repo` and three repos → an error naming the repos, and the model retries
   with one.
4. **Containment (bug #5):** ask the model to read a path outside every repo root, and a secret file
   (`~/.ssh/id_rsa`, a `.env`). Both refused by `resolveRepoPath` — not read.
5. Turn code search off → tools are `undefined` and the generator still runs via the tool-less path.
6. `pnpm test` green, including the new `repoPaths.test.ts`.

## Commit

`feat(ai): read across every configured repo through one path resolver`
