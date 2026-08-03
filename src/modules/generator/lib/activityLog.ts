// Structured per-step activity emitted by the analyst run engines. The UI
// renders this as a streaming log so the user can see what the agent is
// actually doing (which files it read, what it searched for, what the model
// thought) instead of staring at a single "tool: X" label that flickers.

export type ActivityKind = "thinking" | "tool" | "output" | "error";

export type ActivityEntry = {
  /** Stable id for React keys and pairing tool_use → tool_result events. */
  id: string;
  /** Milliseconds since the run started (UI renders as +1.2s). */
  ts: number;
  kind: ActivityKind;
  /** Canonical tool name from the engine (e.g. "Read", "Grep"). */
  toolName?: string;
  /** One-line description of what the tool was invoked with. */
  inputSummary?: string;
  /** One-line meta about the result ("45 lines · 2.3 KB", "12 matches",
   *  "exit 0") — shown as a caption above the expanded body. */
  outputSummary?: string;
  /** Full, human-readable result body the user can expand: a file's content,
   *  grep hits as `path:line: text`, a command's stdout. Capped at ~8KB so the
   *  log can't balloon on huge reads. */
  outputFull?: string;
  /** Language token (ts/py/rs/json/…) when `outputFull` is source code, so the
   *  strip can syntax-highlight it instead of dumping a flat monospace block.
   *  Only set for file reads; absent ⇒ render as plain pre. */
  outputLang?: string;
  /** Wall-clock duration of the tool call, if known. */
  durationMs?: number;
  /** Error string when kind === "error". */
  error?: string;
};

const OUTPUT_SUMMARY_MAX = 200;
const OUTPUT_FULL_MAX = 8_192;

let counter = 0;

export function newActivityId(): string {
  counter++;
  return `act-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Trim long strings for inline display; preserve enough to be useful but
 *  prevent a single tool call from filling the screen. */
export function clampOutputSummary(s: string): string {
  if (s.length <= OUTPUT_SUMMARY_MAX) return s;
  return s.slice(0, OUTPUT_SUMMARY_MAX - 1) + "…";
}

export function clampOutputFull(s: string): string {
  if (s.length <= OUTPUT_FULL_MAX) return s;
  return s.slice(0, OUTPUT_FULL_MAX - 1) + "…";
}

/** Best-effort human label for a tool call given its raw input object.
 *  Different tool names use different field shapes; we cover the common ones
 *  and fall back to the tool name alone so the log still says something. */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return toolName;
  const get = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  const name = toolName.toLowerCase();

  if (name === "read" || name === "read_file") {
    return get("file_path") ?? get("path") ?? toolName;
  }
  if (name === "glob") {
    const pattern = get("pattern") ?? "";
    const path = get("path");
    return path ? `${pattern} (in ${path})` : pattern || toolName;
  }
  if (name === "grep") {
    const pattern = get("pattern") ?? "";
    // `glob` is a string[] in the suite-chat schema (a string in the Claude CLI
    // one), and `get` only returns strings — so the array form was silently
    // dropped and every row showed a bare pattern. That is what made a grep
    // reporting "0 files scanned" impossible to diagnose: the filter that
    // excluded every file was the one thing not on screen.
    const globList = Array.isArray(input.glob)
      ? (input.glob as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const glob = globList.length > 0 ? globList.join(", ") : get("glob");
    const suffix = glob ?? get("path");
    return suffix ? `${pattern} (${suffix})` : pattern || toolName;
  }
  // `subpath` isn't in the generic key list below, so this used to fall through
  // and render "list_files list_files". Quote-stripping mirrors cleanPathArg in
  // test-plans/lib/suiteChatTools.ts so the label matches what actually got
  // listed — kept inline to keep this module dependency-free.
  if (name === "list_files") {
    const sub = (get("subpath") ?? "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    return sub || "(root)";
  }
  // Generic fallback — pick the first string-valued key that looks like a path
  // or query, otherwise just say the tool name.
  for (const k of ["file_path", "path", "pattern", "query", "command"]) {
    const v = get(k);
    if (v) return v;
  }
  return toolName;
}

/** Convert one Vercel AI SDK `streamText`/`generateText` step into activity
 *  entries — one per tool call, paired with its result by toolCallId. Returns
 *  a single "thinking" entry when the step ran no tools so the log still has a
 *  breadcrumb. Mirrors the generator analyze path so chats and the generator
 *  surface tool activity identically. */
export function stepToActivity(
  step: {
    toolCalls?: Array<{ toolCallId?: string; toolName?: string; input?: unknown }>;
    toolResults?: Array<{ toolCallId?: string; output?: unknown }>;
  },
  startMs: number,
): ActivityEntry[] {
  const calls = step.toolCalls ?? [];
  const results = step.toolResults ?? [];
  if (calls.length === 0) {
    return [{ id: newActivityId(), ts: Date.now() - startMs, kind: "thinking" }];
  }
  return calls.map((call) => {
    const match = results.find((r) => r.toolCallId === call.toolCallId);
    const toolName = call.toolName ?? "tool";
    const fmt = match ? formatToolResult(toolName, match.output) : null;
    return {
      // Key by toolCallId so a live "tool-call" event (emitted from the
      // streaming onChunk handler) and this step-finish event upsert into the
      // SAME row instead of duplicating. Falls back to a fresh id when the SDK
      // didn't surface a call id.
      id: call.toolCallId ?? newActivityId(),
      ts: Date.now() - startMs,
      kind: "tool" as const,
      toolName,
      inputSummary: summarizeToolInput(
        toolName,
        (call.input ?? {}) as Record<string, unknown>,
      ),
      outputSummary: fmt?.summary ? clampOutputSummary(fmt.summary) : undefined,
      outputFull: fmt?.text ? clampOutputFull(fmt.text) : undefined,
      outputLang: fmt?.lang,
    };
  });
}

export function stringifyResult(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Turn a tool's raw result object into a readable observation for the activity
 *  strip — the heart of "a file read should show formatted code, not garbled
 *  JSON". Per tool we pull out the payload that matters: a file's content (as
 *  syntax-highlightable code), grep hits as `path:line: text`, a command's
 *  stdout verbatim. Anything unrecognized falls back to indented JSON. Minimal
 *  by design (mini-swe-agent style): a clean observation, not a data viewer.
 *
 *  Returns `summary` (a one-line caption), `text` (the full body), and an
 *  optional `lang` token when the body is source code. Shared by the streaming
 *  (onChunk) and batch (onStepFinish) paths so tool output looks identical
 *  whether it streamed live or was rehydrated from history. */
export function formatToolResult(
  toolName: string | undefined,
  output: unknown,
): { summary: string; text: string; lang?: string } {
  if (output == null) return { summary: "", text: "" };
  if (typeof output === "string") return { summary: oneLine(output), text: output };
  if (typeof output !== "object") {
    const s = String(output);
    return { summary: oneLine(s), text: s };
  }
  const o = output as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof o[k] === "string" ? (o[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof o[k] === "number" ? (o[k] as number) : undefined;

  // A tool can succeed at the SDK level yet return `{ error }` (refused path,
  // bad command). Surface that as the body so the user sees why.
  const errText = str("error");
  if (errText) return { summary: `error · ${oneLine(errText)}`, text: errText };

  const name = (toolName ?? "").toLowerCase();

  if (name === "read_file" || name === "read") {
    if (o.unchanged === true) {
      return {
        summary: "unchanged since last read",
        text: "(unchanged since the previous read of this file — the earlier result still applies)",
      };
    }
    const content = str("content") ?? "";
    const totalLines = num("total_lines");
    const size = num("size");
    const parts: string[] = [];
    if (totalLines != null) parts.push(`${totalLines} line${totalLines === 1 ? "" : "s"}`);
    if (size != null) parts.push(formatBytes(size));
    if (o.truncated === true) parts.push("truncated");
    return {
      summary: parts.join(" · ") || "read",
      text: content,
      lang: langFromPath(str("path") ?? ""),
    };
  }

  if (name === "grep") {
    const files = num("files_scanned");
    const truncated = o.truncated === true;
    // `filesOnly: true` returns per-file counts instead of line text.
    if (Array.isArray(o.files)) {
      const rows = o.files as Array<Record<string, unknown>>;
      return {
        summary:
          `${rows.length}${truncated ? "+" : ""} file${rows.length === 1 ? "" : "s"} matched` +
          (files != null ? ` · ${files} scanned` : ""),
        text:
          rows
            .map((f) => `${String(f.rel ?? "")} (${String(f.matches ?? "?")} matches)`)
            .join("\n") ||
          str("hint") ||
          "(no matches)",
      };
    }
    const hits = Array.isArray(o.hits) ? (o.hits as Array<Record<string, unknown>>) : [];
    const lines = hits.map((h) => {
      const rel =
        typeof h.rel === "string"
          ? h.rel
          : typeof h.path === "string"
            ? (h.path as string)
            : "";
      const line = typeof h.line === "number" ? h.line : "";
      const text = typeof h.text === "string" ? h.text : "";
      return `${rel}:${line}: ${text}`;
    });
    const sum =
      `${hits.length}${truncated ? "+" : ""} match${hits.length === 1 ? "" : "es"}` +
      (files != null ? ` · ${files} file${files === 1 ? "" : "s"} scanned` : "");
    // "0 files scanned" states the fact; the hint (set by the tool when the
    // search never read anything) states the reason. Body, not summary — it's a
    // sentence, and the expandable pane is where there's room for it.
    return {
      summary: sum,
      text: lines.join("\n") || str("hint") || "(no matches)",
    };
  }

  if (name === "glob") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const truncated = o.truncated === true;
    return {
      summary: `${hits.length}${truncated ? "+" : ""} file${hits.length === 1 ? "" : "s"}`,
      text: hits.join("\n") || "(no files matched)",
    };
  }

  // Two listing tools, two result shapes. `list_files` (suite-chat tools →
  // Rust fs_list_files) returns a flat `files: string[]`; `list_directory`
  // (ai/tools/fs) returns `entries: {name, kind}[]`. Reading `entries` for both
  // is why every list_files call used to render "0 entries" no matter how many
  // paths came back — which read as "the AI found nothing".
  if (name === "list_files") {
    const files = Array.isArray(o.files)
      ? (o.files as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const truncated = o.truncated === true;
    return {
      summary: `${files.length}${truncated ? "+" : ""} file${files.length === 1 ? "" : "s"}`,
      text: files.join("\n") || "(no files)",
    };
  }

  if (name === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<Record<string, unknown>>)
      : [];
    const lines = entries.map((e) => {
      const n = typeof e.name === "string" ? e.name : "";
      const kind = typeof e.kind === "string" ? e.kind : "";
      return kind === "dir" || kind === "directory" ? `${n}/` : n;
    });
    return {
      summary: `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
      text: lines.join("\n") || "(empty)",
    };
  }

  if (name === "run_command") {
    const out = str("output") ?? "";
    const code = num("returncode");
    const truncated = o.truncated === true;
    return {
      summary: `${code != null ? `exit ${code}` : "done"}${truncated ? " · truncated" : ""}`,
      text: out || "(no output)",
    };
  }

  // Unknown tool — indented JSON still beats a minified one-liner.
  let text: string;
  try {
    text = JSON.stringify(output, null, 2);
  } catch {
    text = String(output);
  }
  return { summary: oneLine(text), text, lang: "json" };
}

/** Collapse whitespace to a single line for caption text. */
function oneLine(s: string): string {
  return clampOutputSummary(s.replace(/\s+/g, " ").trim());
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Map a file path's extension to a ChatCodeMirror fence token. Unknown
 *  extensions return undefined ⇒ the body renders as plain (still readable). */
function langFromPath(path: string): string | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  if (!m) return undefined;
  const ext = m[1].toLowerCase();
  const map: Record<string, string> = {
    ts: "ts", mts: "ts", cts: "ts", tsx: "tsx",
    js: "js", mjs: "js", cjs: "js", jsx: "jsx", node: "js",
    py: "py", pyi: "py",
    rs: "rs", go: "go",
    json: "json", jsonc: "json",
    md: "md", mdx: "md", markdown: "md",
    html: "html", htm: "html", xml: "xml", vue: "vue", svelte: "svelte",
    razor: "razor", cshtml: "cshtml", aspx: "aspx",
    css: "css", scss: "scss", less: "less", sass: "sass",
    cs: "cs", c: "c", h: "c", cpp: "cpp", "cc": "cpp", hpp: "hpp", java: "java",
    sh: "sh", bash: "bash", zsh: "zsh", ps1: "ps1",
  };
  return map[ext];
}

/** Compact label for the spinner caption — most recent thing the agent did. */
export function entryToLabel(entry: ActivityEntry): string {
  if (entry.kind === "tool" && entry.toolName) {
    return entry.inputSummary
      ? `${entry.toolName}: ${entry.inputSummary}`
      : entry.toolName;
  }
  if (entry.kind === "error") return entry.error ?? "Error";
  if (entry.kind === "output") return "Reading result…";
  return "Thinking…";
}
