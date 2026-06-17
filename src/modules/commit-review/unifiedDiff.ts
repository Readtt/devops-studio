// Parser for `git diff --no-color` output — the `rawPatch` field of CommitDiff
// (src-tauri/src/modules/git.rs). Turns the flat patch text into per-file
// sections with hunks and accurate old/new line numbers so the Commit Review
// pane can render the change the way an IDE does.
//
// Deliberately tolerant of truncated input: rawPatch is capped at ~30 KiB and
// the cap can land mid-line (git.rs `cap_patch`), so an unterminated trailing
// hunk is rendered as far as it parsed and never throws. The `truncated` flag
// on CommitDiff is what the UI uses to explain any shortfall.

export type DiffLineKind = "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  /** 1-based line number in the old file, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null for a removed line. */
  newLine: number | null;
  /** Line content with the leading +/-/space marker stripped. */
  text: string;
};

export type DiffHunk = {
  /** The full `@@ -a,b +c,d @@ heading` line, shown verbatim as a separator. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type FileStatus = "added" | "deleted" | "renamed" | "modified";

export type FileDiff = {
  /** Display path — the new path (or the old path for a deletion). */
  path: string;
  /** Old path, set for renames/copies so the UI can show "old → new". */
  oldPath: string | null;
  status: FileStatus;
  /** True when git emitted "Binary files … differ" instead of hunks. */
  isBinary: boolean;
  hunks: DiffHunk[];
  /** Lines added, counted from the parsed hunks (matches what's rendered). */
  additions: number;
  /** Lines removed, counted from the parsed hunks. */
  deletions: number;
};

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Strip git's `a/` / `b/` (or other single-letter mnemonic) prefix from a
 *  patch path. Leaves `/dev/null` and unprefixed paths untouched. */
function stripPrefix(p: string): string {
  // Git appends a tab before a trailing-space filename; drop anything past it.
  const path = p.split("\t")[0];
  return /^[a-z]\//i.test(path) ? path.slice(2) : path;
}

/** Parse `git diff --no-color` text into per-file diffs. Never throws. */
export function parseUnifiedDiff(raw: string): FileDiff[] {
  if (!raw) return [];

  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  // A CRLF file's content lines arrive as "…\r" before the LF; strip the
  // carriage return so it doesn't trail every rendered line (git's own
  // metadata lines are pure LF, so this only ever touches file content).
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // A new file section always resets hunk state.
    if (line.startsWith("diff --git ")) {
      const m = line.slice("diff --git ".length).match(/^a\/(.+) b\/(.+)$/);
      current = {
        path: m ? m[2] : line.slice("diff --git ".length),
        oldPath: null,
        status: "modified",
        isBinary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(current);
      hunk = null;
      continue;
    }

    if (!current) continue; // preamble before any "diff --git" — ignore.

    // Hunk header.
    const hm = line.match(HUNK_RE);
    if (hm) {
      oldNo = parseInt(hm[1], 10);
      newNo = parseInt(hm[2], 10);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      current.hunks.push(hunk);
      continue;
    }

    // Inside a hunk: classify by the first character.
    if (hunk) {
      const c = line[0];
      if (c === "+") {
        hunk.lines.push({ kind: "add", oldLine: null, newLine: newNo, text: line.slice(1) });
        newNo++;
        current.additions++;
      } else if (c === "-") {
        hunk.lines.push({ kind: "del", oldLine: oldNo, newLine: null, text: line.slice(1) });
        oldNo++;
        current.deletions++;
      } else if (c === " ") {
        hunk.lines.push({ kind: "context", oldLine: oldNo, newLine: newNo, text: line.slice(1) });
        oldNo++;
        newNo++;
      } else if (c === "\\") {
        // "\ No newline at end of file" — metadata, no line-number effect.
      } else {
        // Blank trailing line or a truncation marker — end the hunk, drop it.
        hunk = null;
      }
      continue;
    }

    // File-header region (between "diff --git" and the first hunk).
    if (line === "--- /dev/null") {
      current.status = "added";
    } else if (line === "+++ /dev/null") {
      current.status = "deleted";
    } else if (line.startsWith("+++ ")) {
      if (current.status !== "renamed") current.path = stripPrefix(line.slice(4));
    } else if (line.startsWith("--- ")) {
      // Old-side header — path already known from "diff --git"; nothing to do.
    } else if (line.startsWith("new file")) {
      current.status = "added";
    } else if (line.startsWith("deleted file")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
    } else if (line.startsWith("copy from ")) {
      current.oldPath = line.slice("copy from ".length);
      current.status = "renamed";
    } else if (line.startsWith("copy to ")) {
      current.path = line.slice("copy to ".length);
      current.status = "renamed";
    } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
    }
    // Everything else (index, old/new mode, similarity index) is ignored.
  }

  return files;
}
