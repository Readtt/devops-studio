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

/** Build the set of read-only fs tools the BYOK suite-chat runner can
 *  hand to the model. Returns `undefined` when no source dir is set — the
 *  caller should fall back to a tools-less run in that case. */
export function buildSuiteChatTools(sourceRoot: string | null) {
  if (!sourceRoot) return undefined;
  const root = sourceRoot;

  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file from the user's source directory. Returns up to 1500 lines / 24 KB by default; use `offset` and `limit` to window large files. Refuses binary files. Use this to verify whether a test case's steps match how the code actually behaves — quote the exact lines back to the user with file:line refs.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Path inside the source directory. Can be absolute or relative — relative is resolved against the user's source root.",
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
        try {
          const raw = await invoke<RawReadResult>("fs_read_file", {
            path: resolvePathHint(path, root),
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
            content = content.slice(0, READ_BYTE_CAP);
            truncated = true;
          }
          return {
            path,
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
        "List file paths inside the user's source directory. Returns up to `limit` paths. Use this when you need to discover what files exist before reading them — much cheaper than guessing paths.",
      inputSchema: z.object({
        subpath: z
          .string()
          .optional()
          // "Empty ... lists from the root" invited models to literally send
          // `""`, which used to be joined onto the root as a directory named
          // `""`. cleanPathArg now absorbs that either way; this just stops
          // asking for it.
          .describe(
            "Optional sub-directory of the source root to list, e.g. `src/auth`. Omit it entirely to list from the root.",
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
        try {
          const base = sub ? joinPath(root, sub) : root;
          const out = await invoke<{ files: string[]; truncated: boolean }>(
            "fs_list_files",
            {
              root: base,
              limit: limit ?? 120,
              // workspace defaults to Local on the Rust side; we don't pass
            // one because the WorkspaceEnv shape is internal.
            },
          );
          return out;
        } catch (e) {
          return { error: String(e), subpath: sub };
        }
      },
    }),

    grep: tool({
      description:
        "Regex search across files in the user's source directory. Use this to find references to a function, a constant, an endpoint, an HTTP status code — anything you'd reach for grep to find. Returns matching lines with file:line refs.",
      inputSchema: z.object({
        pattern: z
          .string()
          .min(1)
          .describe("Regular expression pattern. JavaScript regex syntax."),
        glob: z
          .array(z.string())
          .optional()
          .describe(
            'Optional file globs to scope the search (e.g. ["**/*.ts","**/*.tsx"]).',
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
      }),
      execute: async ({ pattern, glob, caseInsensitive, maxResults }) => {
        try {
          const out = await invoke<unknown>("fs_grep", {
            pattern,
            root,
            glob: glob ?? null,
            caseInsensitive: caseInsensitive ?? false,
            maxResults: maxResults ?? 80,
            // workspace defaults to Local on the Rust side; we don't pass
            // one because the WorkspaceEnv shape is internal.
          });
          return out;
        } catch (e) {
          return { error: String(e), pattern };
        }
      },
    }),

    run_command: tool({
      description:
        "Run ONE read-only command in the user's source directory and get its output back — a real terminal, but read-only. Best for inspecting git history and the working tree: `git log --oneline -20`, `git show <sha>`, `git diff`, `git blame <file>`, `git status`, plus `ls`, `cat`, `head`, `tail`, `grep`/`rg`, `find`, `tree`, `wc`. Rules: one command per call (no pipes, redirection, or chaining), no absolute paths, read-only programs only — anything that writes, deletes, or executes is refused. Use this to answer 'what recently changed here / is this code stable or risky' instead of guessing.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .describe(
            'A single read-only command, e.g. `git log --oneline -10 src/auth` or `rg "TODO" src`. No pipes/redirection; no absolute paths.',
          ),
      }),
      execute: async ({ command }) => {
        try {
          const out = await invoke<{
            returncode: number;
            output: string;
            truncated: boolean;
          }>("run_readonly_command_cmd", { root, command });
          return out;
        } catch (e) {
          // A disallowed command surfaces here as the Rust error string — the
          // model reads it and corrects (e.g. "use a read-only git subcommand").
          return { error: String(e), command };
        }
      },
    }),
  } as const;
}

/** Strip whitespace and surrounding quotes off a model-supplied path argument.
 *  Models routinely write `""` to mean "no value" (our own schema says "Empty /
 *  omitted lists from the root") and wrap real paths in quotes. Both used to be
 *  joined verbatim, so `subpath: '""'` became `<root>\""` and the Rust side
 *  answered `not a directory` — a listing the model could never get to work.
 *  Quotes are illegal in Windows filenames and vanishingly rare elsewhere, and
 *  we only touch the ends, so stripping them is safe.
 *
 *  Mirrored (deliberately, to keep that module dependency-free) by the
 *  `list_files` label in generator/lib/activityLog.ts. */
function cleanPathArg(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/** Coerce a model-supplied path into something the Rust fs commands like:
 *  if it starts with the source root, pass through; otherwise treat it as
 *  relative and join against the root. We avoid full canonicalize here so
 *  the model gets predictable echoed paths in tool results. */
function resolvePathHint(path: string, root: string): string {
  const trimmed = cleanPathArg(path);
  if (!trimmed) return root;
  // Absolute-looking? Hand off — the Rust side will still enforce the
  // workspace boundary so it can't escape.
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) return trimmed;
  return joinPath(root, trimmed);
}

function joinPath(a: string, b: string): string {
  const sep = a.includes("\\") ? "\\" : "/";
  const aTrim = a.replace(/[\\/]+$/, "");
  const bTrim = b.replace(/^[\\/]+/, "");
  return `${aTrim}${sep}${bTrim}`;
}
