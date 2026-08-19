// Read-only filesystem tools wired into the Vercel SDK runner for suite
// chat. The Claude Agent SDK already has its own Read/Glob/Grep — this
// gives BYOK users the same code-grounding capability so the feature
// experience is consistent regardless of which engine drives the chat.
//
// Scope is deliberately small. The model never gets write or shell access
// in this context; it can only read text files, list paths, and grep —
// which is plenty to verify "do these cases actually exercise the code".

import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { cleanPathArg, joinPath, resolveRepoPath } from "@/modules/ai/lib/repoPaths";
import { checkReadable } from "@/modules/ai/lib/security";
import type { WorkspaceRepo } from "@/modules/settings/store";

/** Mirror of the Rust ReadResult enum's TS shape. Internal — callers don't
 *  see this; we collapse it to a sensible value below. */
type RawReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/** Default windowing caps for the read tool. Raised so the agentic read loop
 *  can pull a whole module in one call (deeper, Claude-Code-level reading)
 *  instead of paging a long file across many tool calls. The truncation hint
 *  still lets it chain when a file genuinely overflows. */
const READ_LINE_CAP = 1500;
const READ_BYTE_CAP = 24 * 1024;

/** Ceiling on any single tool result, in characters of serialized JSON.
 *  Claude Code's figure. Nothing gets past it: once `execute` returns an
 *  oversized result the SDK has already appended it to the transcript, so the
 *  NEXT request 400s and no amount of later compaction can undo it. The cap
 *  has to be here, at the tool boundary. */
export const TOOL_RESULT_CAP = 50_000;
/** What survives when a result blows the cap. */
const TOOL_RESULT_PREVIEW = 2_000;

/** Ceiling on the COMBINED size of every tool result attached to one message.
 *  Claude Code's figure, and the second line of defence behind
 *  {@link TOOL_RESULT_CAP}: a model that fans out four parallel greps hands
 *  back 4 × 50,000 in a single turn, which a per-result cap is blind to.
 *  Results are served in the order they resolve, so the first ones in a turn
 *  get their full allowance and later ones shrink to whatever is left. */
export const MESSAGE_RESULT_CAP = 200_000;

/** Per-hit line clip for grep display. Rust already clips to 2 KB centred on
 *  the match; 80 of those is 160 KB, which is why this second, tighter clip
 *  exists. */
const GREP_LINE_CAP = 160;

/** Line budget a `filesOnly` grep walks before Rust stops appending. Matches
 *  `HARD_MAX_RESULTS` in src-tauri/src/modules/fs/grep.rs, which clamps
 *  anything larger — this mode returns one row per FILE, so a bigger line
 *  budget buys coverage without growing the answer. */
const FILES_ONLY_SCAN_CAP = 2000;

/** Build the set of read-only fs tools the BYOK suite-chat runner can hand to
 *  the model, spanning every repo it is given. Returns `undefined` for an empty
 *  list — the caller should fall back to a tools-less run in that case.
 *
 *  Paths in and out are `<repoName>/<path within repo>` at every repo count,
 *  including one: a single addressing form means one prompt and one code path,
 *  and every path the model emits round-trips back to the repo it came from. */
export function buildSuiteChatTools(repos: WorkspaceRepo[]) {
  if (repos.length === 0) return undefined;
  const names = repos.map((r) => r.name).join(", ");

  return withResultCaps({
    read_file: tool({
      description:
        "Read a UTF-8 text file from one of the user's source repos. Returns up to 1500 lines / 24 KB by default; use `offset` and `limit` to window large files. Refuses binary files. Use this to verify whether a test case's steps match how the code actually behaves — quote the exact lines back to the user with file:line refs.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            `Path as \`<repo>/<path within repo>\`, e.g. \`${repos[0].name}/src/auth/login.ts\`. Configured repos: ${names}.`,
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based start line. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(3000)
          .optional()
          .describe("Max lines to return. Default 1500."),
      }),
      execute: async ({ path, offset, limit }) => {
        // A refusal is handed BACK to the model as the result rather than
        // thrown: it names what was wrong, so the next call self-corrects.
        const target = await resolveRepoPath(path, repos);
        if (!target.ok) return { error: target.reason, path };
        try {
          const raw = await invoke<RawReadResult>("fs_read_file", {
            path: target.absPath,
            // workspace defaults to Local on the Rust side; we don't pass
            // one because the WorkspaceEnv shape is internal.
          });
          if (raw.kind === "binary") {
            return { error: `binary file refused (${raw.size} bytes)`, path };
          }
          if (raw.kind === "toolarge") {
            return {
              error: `file too large (${raw.size} bytes, limit ${raw.limit})`,
              path,
            };
          }
          const lines = raw.content.split("\n");
          const start = offset ?? 0;
          const requested = limit ?? READ_LINE_CAP;
          const end = Math.min(lines.length, start + requested);
          let content = lines.slice(start, end).join("\n");
          let truncated = end < lines.length;
          if (content.length > READ_BYTE_CAP) {
            content = sliceWholeChars(content, READ_BYTE_CAP);
            truncated = true;
          }
          return {
            path,
            ...(target.corrected ? { corrected: target.corrected } : {}),
            content,
            size: raw.size,
            total_lines: lines.length,
            start_line: start,
            end_line: end,
            ...(truncated
              ? { truncated: true, hint: "call read_file with a higher offset to continue" }
              : {}),
          };
        } catch (e) {
          return { error: String(e), path };
        }
      },
    }),

    list_files: tool({
      description:
        "List file paths inside the user's source repos. Omit `subpath` to see every repo at once; pass one to drill into a single directory. Returns up to `limit` paths. Use this when you need to discover what files exist before reading them — much cheaper than guessing paths.",
      inputSchema: z.object({
        subpath: z
          .string()
          .optional()
          // "Empty ... lists from the root" invited models to literally send
          // `""`, which used to be joined onto the root as a directory named
          // `""`. cleanPathArg now absorbs that either way; this just stops
          // asking for it.
          .describe(
            `Optional directory to list, as \`<repo>/<path within repo>\` — e.g. \`${repos[0].name}/src/auth\`, or \`${repos[0].name}\` for one whole repo. Omit it entirely to list across all of: ${names}.`,
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe("Cap on returned paths. Default 120."),
      }),
      execute: async ({ subpath, limit }) => {
        const sub = cleanPathArg(subpath);
        const cap = limit ?? 120;
        if (sub) {
          const target = await resolveRepoPath(sub, repos);
          if (!target.ok) return { error: target.reason, subpath: sub };
          const one = await listOne(target.virtualPath, target.absPath, cap);
          return one.error
            ? { error: one.error, subpath: sub }
            : { files: one.files, truncated: one.truncated };
        }
        // No subpath: every repo, an equal share of the cap each, so a repo
        // with 10k files can't crowd the others out of the listing.
        const share = Math.ceil(cap / repos.length);
        const parts = await Promise.all(
          repos.map(async (r) => ({ repo: r, ...(await listOne(r.name, r.root, share)) })),
        );
        return {
          files: parts.flatMap((p) => p.files),
          truncated: parts.some((p) => p.truncated),
          ...repoErrors(parts),
        };
      },
    }),

    grep: tool({
      description: `Regex search across every one of the user's source repos (${names}) at once. Use this to find references to a function, a constant, an endpoint, an HTTP status code — anything you'd reach for grep to find. Returns matching lines as \`<repo>/<path>\` with line numbers, drawn evenly from each repo. Long lines are clipped around the match — read_file that file:line to see the rest.`,
      inputSchema: z.object({
        pattern: z
          .string()
          .min(1)
          .describe("Regular expression pattern. JavaScript regex syntax."),
        glob: z
          .array(z.string())
          .optional()
          .describe(
            'Optional file globs to scope the search (e.g. ["**/*.ts","**/*.tsx"]). Matched inside each repo, against paths relative to that repo\'s root — do NOT put a repo name in a glob.',
          ),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe("Whether the pattern should be case-insensitive. Default false."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Cap on returned matches. Default 80."),
        filesOnly: z
          .boolean()
          .optional()
          .describe(
            "Return only which files matched (path + match count), no line text. Use for a broad 'where does this live' scan; then grep again narrowed, or read_file. Default false.",
          ),
      }),
      execute: async ({ pattern, glob, caseInsensitive, maxResults, filesOnly }) => {
        const lineCap = maxResults ?? 80;
        const parts = await Promise.all(
          repos.map((repo) =>
            grepOne(repo, {
              pattern,
              root: repo.root,
              glob: glob ?? null,
              caseInsensitive: caseInsensitive ?? false,
              // `maxResults` counts matching LINES on the Rust side, and
              // `filesOnly` then collapses those lines to one row per file — so
              // the file list a broad scan returns was bounded by line hits,
              // not by files. A symbol with 80 references inside one hot file
              // filled the default cap inside that file and came back as "1
              // file matched" for something used in twenty. Scanning wide is
              // the whole point of this mode and its result is small however
              // many lines it walked, so it runs at the Rust hard ceiling
              // instead. The line-returning mode keeps the caller's cap: there
              // the number really is the size of what comes back. Each repo is
              // asked for the full cap — the merge below holds the ANSWER to it.
              maxResults: filesOnly ? FILES_ONLY_SCAN_CAP : lineCap,
              // workspace defaults to Local on the Rust side; we don't pass
              // one because the WorkspaceEnv shape is internal.
            }),
          ),
        );
        const scanned = parts.reduce((n, p) => n + (p.out?.files_scanned ?? 0), 0);
        // Per-repo truncation only. The MERGE has a cap of its own, and each
        // branch below folds its own overflow in: three repos that each fit
        // comfortably under the Rust ceiling still overflow once interleaved,
        // and answering `truncated: false` there tells the model it has seen
        // every reference to the symbol when it has seen a third of them.
        const repoTruncated = parts.some((p) => p.out?.truncated);
        const base = {
          files_scanned: scanned,
          // `files_scanned` counts files AFTER the glob filter, so 0 means
          // nothing was ever read — which is NOT evidence the pattern is
          // absent. Left unsaid, a model reads "0 matches" as "this code
          // doesn't exist" and moves on with a wrong conclusion.
          ...(scanned === 0 ? { hint: emptyScanHint(glob, repos) } : {}),
          ...repoErrors(parts),
        };
        if (filesOnly) {
          // The SCAN ignores the caller's cap (see above); the ANSWER can't —
          // every repo contributing hundreds of file rows serializes past
          // TOOL_RESULT_CAP, and an over-cap result is replaced wholesale by a
          // mid-structure preview, so the model loses the scan instead of
          // getting its first N files.
          const files = interleave(
            parts.map((p) =>
              summariseByFile(readableHits(p.repo, p.out?.hits ?? [])).map((f) => ({
                ...f,
                rel: `${p.repo.name}/${f.rel}`,
              })),
            ),
          );
          return {
            ...base,
            truncated: repoTruncated || files.length > lineCap,
            files: files.slice(0, lineCap),
          };
        }
        const re = displayMatcher(pattern, caseInsensitive ?? false);
        // Round-robin, then truncate. Concatenating instead lets one repo's
        // 80 hits fill the cap and hide another repo entirely — which is the
        // silent coverage loss this whole feature exists to end.
        // `path` is dropped: it duplicates `rel` on every hit, and `rel` is
        // now the repo-prefixed form read_file takes.
        const hits = interleave(
          parts.map((p) =>
            readableHits(p.repo, p.out?.hits ?? []).map((h) => ({
              rel: `${p.repo.name}/${h.rel}`,
              line: h.line,
              text: clipAroundMatch(h.text, re, GREP_LINE_CAP),
            })),
          ),
        );
        return {
          ...base,
          truncated: repoTruncated || hits.length > lineCap,
          hits: hits.slice(0, lineCap),
        };
      },
    }),

    run_command: tool({
      description: `Run ONE read-only command inside ONE of the user's source repos (${names}) and get its output back — a real terminal, but read-only. Reach for git, the one program guaranteed to be installed: \`git log --oneline -20\`, \`git show <sha>\`, \`git show <sha>:<path>\` (a file as of that commit), \`git diff\`, \`git blame <file>\`, \`git status\`, \`git ls-files\`, \`git grep <pattern>\`, \`git for-each-ref --sort=-committerdate refs/heads\` (branches), \`git check-ignore -v <path>\`. \`ls\`/\`cat\`/\`head\`/\`tail\`/\`grep\`/\`rg\` are allowed but are usually ABSENT on Windows, and \`find\`/\`tree\` there are unrelated Microsoft programs of the same name — read, list and search with the read_file / list_files / grep tools instead, and keep this one for git. Rules: one command per call (no pipes, redirection, or chaining), no absolute paths — anything that writes, deletes, or executes is refused. Use this to answer 'what recently changed here / is this code stable or risky' instead of guessing.`,
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .describe(
            'A single read-only command, e.g. `git log --oneline -10 src/auth` or `rg "TODO" src`. Paths in the command are relative to the chosen repo and carry no repo prefix. No pipes/redirection; no absolute paths.',
          ),
        // Optional, not required: the schema is shared with a one-repo
        // workspace, where there is nothing to disambiguate.
        repo: z
          .string()
          .optional()
          .describe(
            `Which repo to run in — one of: ${names}. Required when more than one is configured; a command sees only the repo it runs in (git history included).`,
          ),
      }),
      execute: async ({ command, repo }) => {
        const target = pickRepo(repo, repos);
        if (!target.ok) return { error: target.reason, command };
        if (CLIMBS_OUT.test(command)) {
          return {
            error:
              "Refused: `..` climbs out of the repo. Paths in a command are relative to the repo it runs in — to read another repo, call again with that `repo`.",
            command,
          };
        }
        const secret = secretOperand(command, target.repo);
        if (secret) {
          return {
            error: `Refused: \`${secret}\` matches a sensitive-file pattern. read_file and grep refuse it too — this shell is not a way around them.`,
            command,
          };
        }
        try {
          const out = await invoke<{
            returncode: number;
            output: string;
            truncated: boolean;
          }>("run_readonly_command_cmd", { root: target.repo.root, command });
          return { ...out, repo: target.repo.name };
        } catch (e) {
          // A disallowed command surfaces here as the Rust error string — the
          // model reads it and corrects (e.g. "use a read-only git subcommand").
          return { error: String(e), command };
        }
      },
    }),
  } as const);
}

/** A `..` path segment anywhere in a command line.
 *
 *  `run_command` is the one tool that doesn't route its paths through
 *  `resolveRepoPath`, and the Rust validator only rejects ABSOLUTE paths — so
 *  `cat ../other-repo/appsettings.json` runs, reading a repo the user may have
 *  deselected in the Repos chips, or anything else beside the repo root. Every
 *  legitimate use of this tool is repo-relative; another repo is reachable by
 *  passing `repo`, which is what the scope is enforced on. */
const CLIMBS_OUT = /(^|[^\w.])\.\.($|[\\/])/;

/** The first operand of a command that names a file the read gate refuses, or
 *  null when none does.
 *
 *  `run_command` is the last read path with no gate on it. `readableHits` closed
 *  the same hole for `grep` — `.env` was unreadable by name and readable by
 *  pattern — but a shell reaches the file directly: `cat .env` where cat
 *  exists, and `git show HEAD:.env` / `git log -p .env` on any platform, for
 *  anything tracked.
 *
 *  Operands only. The PATTERN argument of a search is skipped, because it is not
 *  a path and refusing `git grep "\.pem"` would be a refusal about a string. What
 *  that search can still surface from a tracked secret file is out of reach of a
 *  path check — the residual this doesn't close. */
function secretOperand(command: string, repo: WorkspaceRepo): string | null {
  for (const cand of pathOperands(command)) {
    if (!checkReadable(joinPath(repo.root, cand)).ok) return cand;
  }
  return null;
}

/** Search programs take a PATTERN before their paths, so the first operand is
 *  skipped for these. `git` is handled through its subcommand. */
const PATTERN_FIRST = new Set(["grep", "rg"]);

function pathOperands(command: string): string[] {
  const tokens = tokenize(command);
  if (tokens.length < 2) return [];
  const program = tokens[0].toLowerCase();
  let args = tokens.slice(1);

  let patternFirst = PATTERN_FIRST.has(program);
  if (program === "git") {
    // Drop everything up to and including the subcommand, so a glued
    // `--git-dir=` (already refused by Rust) and the subcommand itself aren't
    // read as paths.
    const sub = args.findIndex((a) => !a.startsWith("-"));
    if (sub === -1) return [];
    patternFirst = args[sub].toLowerCase() === "grep";
    args = args.slice(sub + 1);
  }

  const out: string[] = [];
  let skipped = !patternFirst;
  for (const raw of args) {
    if (raw === "--") continue;
    let a = raw;
    if (a.startsWith("-")) {
      // A glued flag value can still be a path (`--exclude-from=.env`); a bare
      // flag never is.
      const eq = a.indexOf("=");
      if (eq === -1) continue;
      a = a.slice(eq + 1);
    } else if (!skipped) {
      skipped = true;
      continue;
    }
    if (!a) continue;
    out.push(a);
    // `git show <rev>:<path>` addresses a file through a revision, and the
    // basename of the whole token is `<rev>:<path>`, which matches nothing.
    const colon = a.lastIndexOf(":");
    if (colon > 0 && colon < a.length - 1) out.push(a.slice(colon + 1));
  }
  return out;
}

/** Whitespace split that keeps `"..."` / `'...'` runs together — the same rule
 *  the Rust tokenizer follows, so this sees the operands Rust will. */
function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
  }
  if (started || cur) out.push(cur);
  return out;
}

/** Mirror of the Rust `GrepResponse`. */
type GrepResponse = {
  hits: Array<{ path: string; rel: string; line: number; text: string }>;
  truncated: boolean;
  files_scanned: number;
};

/** One repo's share of a fan-out. A repo that fails — a root the user moved or
 *  unmounted — must not take the other repos' results down with it, so the
 *  failure travels as data and is reported alongside what did come back. */
type RepoPart<T> = { repo: WorkspaceRepo; out?: T; error?: string };

async function listOne(
  prefix: string,
  root: string,
  limit: number,
): Promise<{ files: string[]; truncated: boolean; error?: string }> {
  try {
    const out = await invoke<{ files: string[]; truncated: boolean }>(
      "fs_list_files",
      {
        root,
        limit,
        // workspace defaults to Local on the Rust side; we don't pass one
        // because the WorkspaceEnv shape is internal.
      },
    );
    return {
      files: out.files.map((f) => `${prefix}/${f}`),
      truncated: out.truncated,
    };
  } catch (e) {
    return { files: [], truncated: false, error: String(e) };
  }
}

/** Drop hits in files `read_file` would refuse.
 *
 *  `read_file` clears every path through `resolveRepoPath`, which runs the read
 *  gate; grep is handed the repo ROOT and `fs_grep` walks the tree itself, so
 *  nothing upstream ever sees the files it opened. Without this, `.env` is
 *  unreadable by name and readable by pattern — a grep for `SECRET|_KEY=`
 *  returned its matching lines verbatim. Gated on the joined path, not the
 *  relative one, so the protected-directory rules match the same way they do
 *  for a read. */
function readableHits<T extends { rel: string }>(
  repo: WorkspaceRepo,
  hits: T[],
): T[] {
  return hits.filter((h) => checkReadable(joinPath(repo.root, h.rel)).ok);
}

async function grepOne(
  repo: WorkspaceRepo,
  args: Record<string, unknown>,
): Promise<RepoPart<GrepResponse>> {
  try {
    return { repo, out: await invoke<GrepResponse>("fs_grep", args) };
  } catch (e) {
    return { repo, error: String(e) };
  }
}

/** Surface per-repo failures without hiding the repos that answered. */
function repoErrors(
  parts: Array<{ repo: WorkspaceRepo; error?: string }>,
): { errors?: Array<{ repo: string; error: string }> } | Record<string, never> {
  const errors = parts
    .filter((p) => p.error)
    .map((p) => ({ repo: p.repo.name, error: p.error as string }));
  return errors.length > 0 ? { errors } : {};
}

/** Round-robin merge. Straight concatenation lets the first repo's hits fill
 *  the cap and hide every repo behind it — the exact silent coverage loss
 *  multi-repo support exists to end. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const deepest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < deepest; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]);
    }
  }
  return out;
}

/** Resolve `run_command`'s optional repo argument to exactly one root — a cwd
 *  can only ever be one place. */
function pickRepo(
  wanted: string | undefined,
  repos: WorkspaceRepo[],
): { ok: true; repo: WorkspaceRepo } | { ok: false; reason: string } {
  const names = repos.map((r) => r.name).join(", ");
  const asked = cleanPathArg(wanted);
  if (!asked) {
    if (repos.length === 1) return { ok: true, repo: repos[0] };
    return {
      ok: false,
      reason: `\`repo\` is required with more than one repo configured — a command runs inside a single repo, and \`git log\` in one cannot see another. Pass one of: ${names}.`,
    };
  }
  const hit = repos.find((r) => r.name.toLowerCase() === asked.toLowerCase());
  if (hit) return { ok: true, repo: hit };
  return { ok: false, reason: `No repo named "${asked}". Configured repos: ${names}.` };
}

/** Recovery hint attached when a result blows TOOL_RESULT_CAP — it names the
 *  argument that would narrow THIS call. A stub the model can't act on is lost
 *  information; one it can re-fetch is a cheap retry. */
const RECOVERY_HINTS: Record<string, string> = {
  read_file:
    "Call read_file again with `offset` and a smaller `limit` to page through the file.",
  list_files: "Call list_files again with a `subpath` or a smaller `limit`.",
  grep: "Call grep again with `filesOnly: true`, a narrower `glob`, a smaller `maxResults`, or a more specific pattern.",
  run_command:
    "Run a narrower command — add a path, an `-n` limit, or a smaller commit range.",
};

const GENERIC_RECOVERY = "Call the tool again with narrower arguments.";

/** Last-resort ceiling on a single tool result. Each tool above has its own,
 *  tighter caps; this catches the shapes they miss. Oversized results are
 *  replaced with a preview rather than clipped in place, because a JSON
 *  structure cut mid-object reads as corrupt — Claude Code does the same.
 *
 *  `allowance` is what's left of the message-wide budget; the effective cap is
 *  the tighter of the two. The preview shrinks with it, so a turn that has
 *  already spent its budget can't get N × 2 KB of previews back. */
export function capToolResult(
  result: unknown,
  recovery: string,
  allowance: number = TOOL_RESULT_CAP,
): unknown {
  const cap = Math.min(TOOL_RESULT_CAP, Math.max(0, allowance));
  const serialized = safeStringify(result);
  if (serialized.length <= cap) return result;
  const previewLen = Math.min(TOOL_RESULT_PREVIEW, cap);
  return {
    error: `result too large: ${serialized.length} characters (cap ${cap})`,
    ...(previewLen > 0
      ? { preview: sliceWholeChars(serialized, previewLen) }
      : {}),
    hint:
      (previewLen > 0
        ? `Only the first ${previewLen} characters of the raw result are above, cut mid-structure. `
        : `This turn's tool results have already filled the ${MESSAGE_RESULT_CAP}-character message budget, so none of this one is shown. `) +
      recovery,
  };
}

/** Apply {@link capToolResult} to EVERY tool in the map, and hold them to a
 *  shared per-message budget. Done here, once, rather than at each `execute`'s
 *  return sites, so a tool added later can't quietly ship uncapped — which is
 *  the exact failure this cap exists for. suiteChatTools.test.ts enumerates the
 *  live map and fails if one escapes. */
function withResultCaps<T extends Record<string, unknown>>(tools: T): T {
  // The SDK hands every tool call of a step the same `stepInputMessages` array
  // it built that step's request from, and rebuilds it fresh next step — so the
  // array's IDENTITY is the message key: shared by the parallel calls of one
  // turn, different on the next, and never colliding across runs the way a
  // length or a counter would. A caller that passes no options (direct calls in
  // tests) simply gets the per-result cap.
  let messageRef: unknown;
  let spent = 0;

  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tools)) {
    const t = spec as { execute?: (...args: unknown[]) => Promise<unknown> };
    if (typeof t.execute !== "function") {
      out[name] = spec;
      continue;
    }
    const inner = t.execute;
    const recovery = RECOVERY_HINTS[name] ?? GENERIC_RECOVERY;
    out[name] = {
      ...t,
      execute: async (...args: unknown[]) => {
        const raw = await inner(...args);
        // Charge the budget AFTER the await. Reading it up front would hand
        // every concurrent call of a turn the full allowance, which is exactly
        // the case this cap exists to bound.
        const ref = messageRefOf(args[1]);
        if (ref !== messageRef) {
          messageRef = ref;
          spent = 0;
        }
        const capped = capToolResult(raw, recovery, MESSAGE_RESULT_CAP - spent);
        spent += safeStringify(capped).length;
        return capped;
      },
    };
  }
  return out as T;
}

/** The step's message array from the SDK's tool-call options, or a fresh
 *  sentinel when there isn't one (never equal to the previous key, so the
 *  budget resets and only the per-result cap applies). */
function messageRefOf(options: unknown): unknown {
  const messages = (options as { messages?: unknown } | null | undefined)
    ?.messages;
  return Array.isArray(messages) ? messages : {};
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** Compile the model's pattern for DISPLAY clipping only. Rust runs the real
 *  search with the `regex` crate, so a pattern using syntax JavaScript lacks
 *  must never change which hits come back — a failure here just falls back to
 *  the head of a line Rust has already centred on the match. */
function displayMatcher(pattern: string, caseInsensitive: boolean): RegExp | null {
  try {
    return new RegExp(pattern, caseInsensitive ? "i" : "");
  } catch {
    return null;
  }
}

/** Clip a matched line to `cap`, centred on the match. Head-clipping is what
 *  makes a hit useless: the model is handed a line it was told matched and
 *  can't find the term anywhere in it. */
export function clipAroundMatch(
  text: string,
  re: RegExp | null,
  cap: number,
): string {
  if (text.length <= cap) return text;
  const m = re ? re.exec(text) : null;
  const at = m ? m.index : 0;
  const len = m ? m[0].length : 0;

  let start = Math.max(0, at - Math.floor(Math.max(0, cap - len) / 2));
  start = Math.min(start, text.length - cap);
  let end = start + cap;
  // Never split a surrogate pair — a lone surrogate survives JSON.stringify
  // and reaches the provider as a malformed string.
  if (start > 0 && isLowSurrogate(text, start)) start -= 1;
  if (end > start && isLowSurrogate(text, end)) end -= 1;

  return (
    (start > 0 ? `…[+${start} chars]` : "") +
    text.slice(start, end) +
    (end < text.length ? `…[+${text.length - end} chars]` : "")
  );
}

function isLowSurrogate(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/** `text.slice(0, end)` that never cuts a surrogate pair in half. Same hazard
 *  {@link clipAroundMatch} guards: a lone surrogate survives JSON.stringify and
 *  reaches the provider as a malformed string, which is a 400 for the whole
 *  request — not just a mangled character. */
function sliceWholeChars(text: string, end: number): string {
  if (end >= text.length) return text;
  return text.slice(0, end > 0 && isLowSurrogate(text, end) ? end - 1 : end);
}

/** Collapse hits into one row per file for `filesOnly` scans. */
function summariseByFile(
  hits: GrepResponse["hits"],
): Array<{ rel: string; matches: number; firstLine: number }> {
  const byFile = new Map<string, { rel: string; matches: number; firstLine: number }>();
  for (const h of hits) {
    const seen = byFile.get(h.rel);
    if (seen) {
      seen.matches += 1;
      seen.firstLine = Math.min(seen.firstLine, h.line);
    } else {
      byFile.set(h.rel, { rel: h.rel, matches: 1, firstLine: h.line });
    }
  }
  return [...byFile.values()];
}

/** Why a grep read zero files. Globs are matched with globset inside EACH repo,
 *  against paths relative to that repo's own root, so the ways they silently
 *  match nothing are narrow and worth spelling out: a leading `./` or `/` never
 *  matches, matching is case-sensitive, a directory prefix has to exist at a
 *  repo's top level — and, the multi-repo trap, the `<repo>/` prefix that every
 *  path in a result carries is NOT part of a glob. */
function emptyScanHint(glob: string[] | undefined, repos: WorkspaceRepo[]): string {
  const scope =
    repos.length === 1 ? "the repo" : `any of the ${repos.length} repos`;
  if (glob && glob.length > 0) {
    return (
      "Your `glob` matched no files, so nothing was searched — this is NOT evidence " +
      "the pattern is absent. Globs are matched inside each repo, against paths " +
      "relative to that repo's own root: a repo-name prefix never matches (drop it), " +
      "nor does a leading `./` or `/`, matching is case-sensitive, and any directory " +
      "prefix must exist at a repo's top level. Retry without `glob`, or widen it " +
      "(e.g. `**/*.cs`), before concluding anything."
    );
  }
  return (
    `No files were searched in ${scope} — they are empty, or everything in them is ` +
    "gitignored/hidden. This is NOT evidence the pattern is absent. Check with " +
    "list_files before concluding anything."
  );
}
