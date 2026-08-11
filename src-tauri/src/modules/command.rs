//! Read-only command runner for the AI surfaces.
//!
//! The AI can run a SINGLE command per call, observe its output, and loop —
//! the radically simple shape mini-swe-agent uses. But unlike mini-swe-agent
//! (which runs arbitrary bash in a sandbox), this NEVER mutates the user's
//! tree, so the contract is enforced three ways:
//!
//! 1. No shell. The command string is tokenized and the program is exec'd
//!    directly, so shell metacharacters (`|`, `>`, `$(...)`, `&&`, `~`) are
//!    never interpreted — they're passed as literal args (and usually just
//!    make the command fail) rather than chaining to something dangerous.
//! 2. Hard allowlist. Only inherently read-only programs are permitted; `git`
//!    is limited to read-only subcommands and `find` rejects the flags that
//!    write or execute.
//! 3. No absolute paths. Args can't start at `/`, a UNC root, or a Windows
//!    drive, so reads stay near the project rather than ranging over the disk.
//!
//! Runs in the user's authorized source directory with a timeout + output cap.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

const OUTPUT_CAP: usize = 16_000;
/// How much of the cap comes from the head; the rest is the tail. `git log` /
/// `git diff` / `git show` are the densest evidence Commit Review has, and a
/// head-only clip silently drops the end of the range — which reads to both
/// the model and the reviewer as though the range simply ended there.
const HEAD_SHARE: usize = OUTPUT_CAP * 5 / 8;
/// How far either cut may drift to land on a line break rather than mid-hunk.
const LINE_SNAP: usize = 400;
const RUN_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// Process exit code (-1 if the process was killed / produced no code).
    pub returncode: i32,
    /// Combined stdout + stderr. Over OUTPUT_CAP it keeps the head and the
    /// tail with an elision marker between them.
    pub output: String,
    /// True when output was clipped to the cap.
    pub truncated: bool,
}

/// Inherently read-only programs. `git` and `find` get extra checks below.
const ALLOWED_PROGRAMS: &[&str] = &[
    "git", "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "tree", "pwd",
];

/// git subcommands that only READ. Deliberately excludes branch / tag / remote
/// / config / stash / worktree — those have write forms (e.g. `git branch -d`),
/// and we avoid brittle per-flag analysis by simply not allowing them. The read
/// needs are covered: history, diffs, blame, object inspection.
const GIT_READONLY_SUBCOMMANDS: &[&str] = &[
    "log", "show", "diff", "status", "blame", "rev-parse", "shortlog",
    "describe", "ls-files", "ls-tree", "cat-file", "show-ref", "rev-list",
    "name-rev", "reflog", "grep", "whatchanged", "merge-base", "cherry",
];

/// Shell syntax models write out of habit. There is no shell here (see the
/// module docs), so these reach the program as literal arguments and it fails
/// with its own error: `git show <sha>:<path> | sed -n 1,10p` comes back as git
/// exit 128 "invalid object", which reads like a bad SHA. In the field that
/// sent a run chasing three different refs before it thought to drop the pipe.
/// Rejecting up front with the real reason costs one call instead of four.
///
/// Whole tokens only — `|` inside a quoted argument is a regex alternation
/// (`rg "class A|class B"`), which is exactly what this tool is for.
const SHELL_OPERATORS: &[&str] = &["|", "||", "&", "&&", ";", ">", ">>", "<", "<<"];

/// `find` actions/flags that write to disk or execute — rejected so `find`
/// stays a pure query.
const FIND_DANGEROUS: &[&str] = &[
    "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0",
    "-fprintf", "-fls",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Run one read-only command in `root`. Returns Err for a disallowed command
/// (the message explains why so the model can correct itself) or an execution
/// failure; a non-zero exit from an allowed command is a normal Ok result with
/// the returncode + output, exactly like a shell.
pub async fn run_readonly_command(root: &str, command: &str) -> Result<CommandResult, String> {
    let root_path = Path::new(root);
    if root.is_empty() || !root_path.is_dir() {
        return Err("No source directory is set, so read-only commands can't run.".into());
    }
    let tokens = tokenize(command)?;
    if tokens.is_empty() {
        return Err("Empty command.".into());
    }
    validate(&tokens)?;

    let program = tokens[0].clone();
    let args = &tokens[1..];

    let mut cmd = Command::new(&program);
    cmd.args(args)
        .current_dir(root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't run `{program}`: {e}"))?;

    let out = match timeout(RUN_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("`{program}` failed to run: {e}")),
        Err(_) => {
            return Err(format!(
                "`{program}` timed out after {}s and was stopped.",
                RUN_TIMEOUT.as_secs()
            ))
        }
    };

    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    let truncated = match clip_output(&text) {
        Some(clipped) => {
            text = clipped;
            true
        }
        None => false,
    };

    Ok(CommandResult {
        returncode: out.status.code().unwrap_or(-1),
        output: text,
        truncated,
    })
}

/// Clip output over `OUTPUT_CAP`, keeping BOTH ends with an explicit marker
/// between them. Returns None when nothing needed clipping. The marker names
/// the recovery move, so the model narrows the command instead of concluding
/// the output ended where we cut it.
fn clip_output(text: &str) -> Option<String> {
    if text.len() <= OUTPUT_CAP {
        return None;
    }
    let head_end = snap_back(text, HEAD_SHARE);
    let tail_start = snap_forward(text, text.len() - (OUTPUT_CAP - HEAD_SHARE));
    if tail_start <= head_end {
        return None;
    }

    let elided = text[head_end..tail_start].chars().count();
    let mut out = String::with_capacity(OUTPUT_CAP + 256);
    out.push_str(&text[..head_end]);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!(
        "…[{elided} chars omitted from the middle — narrow the command (add a path, \
         `-n`, or a smaller range) to see them]…\n"
    ));
    out.push_str(&text[tail_start..]);
    Some(out)
}

/// Walk `idx` back to a char boundary, preferring a line break within
/// LINE_SNAP so a diff hunk isn't cut mid-row.
fn snap_back(text: &str, idx: usize) -> usize {
    let mut i = idx.min(text.len());
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    let floor = i.saturating_sub(LINE_SNAP);
    let mut j = i;
    while j > floor {
        if text.as_bytes()[j - 1] == b'\n' {
            return j;
        }
        j -= 1;
    }
    i
}

fn snap_forward(text: &str, idx: usize) -> usize {
    let mut i = idx.min(text.len());
    while i < text.len() && !text.is_char_boundary(i) {
        i += 1;
    }
    let ceiling = (i + LINE_SNAP).min(text.len());
    let mut j = i;
    while j < ceiling {
        if text.as_bytes()[j] == b'\n' {
            return j + 1;
        }
        j += 1;
    }
    i
}

/// Validate the tokenized command against the read-only contract.
fn validate(tokens: &[String]) -> Result<(), String> {
    let program = tokens[0].as_str();
    if program.contains('/') || program.contains('\\') {
        return Err(format!(
            "Only bare program names are allowed, not a path like `{program}`."
        ));
    }
    if !ALLOWED_PROGRAMS.contains(&program) {
        return Err(format!(
            "`{program}` isn't allowed — this is a READ-ONLY shell. Allowed: {}.",
            ALLOWED_PROGRAMS.join(", ")
        ));
    }

    let args = &tokens[1..];
    // Before the path check, so `> /tmp/out.cs` reports the redirect rather
    // than "use a relative path" — which is the wrong reason and invites a
    // retry with `> out.cs` that fails just as opaquely.
    for a in args {
        if is_shell_operator(a) {
            return Err(format!(
                "`{a}` isn't supported — there's no shell here, so pipes, redirection and \
                 chaining are handed to the program as literal arguments (which is why they \
                 come back as a confusing non-zero exit rather than an error about the pipe). \
                 Run one command on its own. To read part of a large file, use the read_file \
                 tool with `offset`/`limit` instead of piping through sed/awk/head."
            ));
        }
    }
    for a in args {
        if is_absolute_path(a) {
            return Err(format!(
                "Absolute path `{a}` isn't allowed — use a path relative to the source directory."
            ));
        }
    }

    if program == "git" {
        // The subcommand is the first non-flag token.
        let sub = args
            .iter()
            .find(|a| !a.starts_with('-'))
            .map(|s| s.as_str())
            .unwrap_or("");
        if !GIT_READONLY_SUBCOMMANDS.contains(&sub) {
            return Err(format!(
                "git `{}` isn't allowed — read-only git only: {}.",
                if sub.is_empty() { "(no subcommand)" } else { sub },
                GIT_READONLY_SUBCOMMANDS.join(", ")
            ));
        }
    }

    if program == "find" {
        for a in args {
            let la = a.to_ascii_lowercase();
            if FIND_DANGEROUS.iter().any(|d| la == *d) {
                return Err(format!(
                    "find `{a}` isn't allowed — it can write or execute. Use find only to list/match."
                ));
            }
        }
    }

    Ok(())
}

/// True when a token IS shell syntax rather than data. Matches whole operator
/// tokens plus the glued forms — `>out.txt`, `2>/dev/null`, `$(cmd)`, backticks
/// — so a metacharacter inside a quoted argument is left alone.
fn is_shell_operator(s: &str) -> bool {
    if SHELL_OPERATORS.contains(&s) {
        return true;
    }
    if s.starts_with('>') || s.starts_with('<') || s.starts_with("$(") {
        return true;
    }
    if s.len() > 1 && s.starts_with('`') && s.ends_with('`') {
        return true;
    }
    // File-descriptor redirection: `2>/dev/null`, `1>&2`.
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && s[digits..].starts_with('>')
}

/// True for paths that escape the project root: Unix `/…`, a UNC `\\…`, or a
/// Windows drive `X:\…` / `X:/…`.
fn is_absolute_path(s: &str) -> bool {
    if s.starts_with('/') || s.starts_with("\\\\") {
        return true;
    }
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Minimal shell-style tokenizer: splits on whitespace but keeps `"..."` and
/// `'...'` quoted runs together. Backslash is a LITERAL character outside
/// quotes (not an escape) so Windows paths like `C:\Windows` survive — use
/// quotes for args with spaces. Does NOT implement shell expansion (the point:
/// no shell semantics).
fn tokenize(input: &str) -> Result<Vec<String>, String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                has = true;
                for d in chars.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                has = true;
                while let Some(d) = chars.next() {
                    if d == '"' {
                        break;
                    }
                    if d == '\\' {
                        if let Some(&n) = chars.peek() {
                            if n == '"' || n == '\\' {
                                cur.push(n);
                                chars.next();
                                continue;
                            }
                        }
                    }
                    cur.push(d);
                }
            }
            c if c.is_whitespace() => {
                if has {
                    tokens.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        tokens.push(cur);
    }
    Ok(tokens)
}

#[tauri::command]
pub async fn run_readonly_command_cmd(
    root: String,
    command: String,
) -> Result<CommandResult, String> {
    run_readonly_command(&root, &command).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_readonly_git() {
        assert!(validate(&toks("git log --oneline -5")).is_ok());
        assert!(validate(&toks("git show HEAD")).is_ok());
        assert!(validate(&toks("git diff")).is_ok());
    }

    #[test]
    fn blocks_git_writes() {
        assert!(validate(&toks("git commit -m x")).is_err());
        assert!(validate(&toks("git push")).is_err());
        assert!(validate(&toks("git checkout main")).is_err());
        assert!(validate(&toks("git branch -d feature")).is_err());
        assert!(validate(&toks("git reset --hard")).is_err());
    }

    #[test]
    fn blocks_non_allowlisted_programs() {
        assert!(validate(&toks("rm -rf .")).is_err());
        assert!(validate(&toks("npm install")).is_err());
        assert!(validate(&toks("bash -c whoami")).is_err());
        assert!(validate(&toks("python script.py")).is_err());
    }

    #[test]
    fn blocks_absolute_paths() {
        assert!(validate(&toks("cat /etc/passwd")).is_err());
        assert!(validate(&toks("ls C:\\Windows")).is_err());
        assert!(validate(&toks("grep secret /var/log/auth.log")).is_err());
    }

    #[test]
    fn blocks_dangerous_find() {
        assert!(validate(&toks("find . -name x -delete")).is_err());
        assert!(validate(&toks("find . -exec rm {} ;")).is_err());
        assert!(validate(&toks("find . -name *.ts")).is_ok());
    }

    #[test]
    fn allows_plain_reads() {
        assert!(validate(&toks("ls -la src")).is_ok());
        assert!(validate(&toks("cat package.json")).is_ok());
        assert!(validate(&toks("grep -rn TODO src")).is_ok());
        assert!(validate(&toks("rg pattern")).is_ok());
    }

    #[test]
    fn tokenizes_quotes() {
        assert_eq!(toks(r#"grep "foo bar" file"#), vec!["grep", "foo bar", "file"]);
        assert_eq!(toks("git log --grep='fix bug'"), vec!["git", "log", "--grep=fix bug"]);
    }

    /// The field failure: `git show <sha>:<path> | sed -n '4280,4540p'` passed
    /// validation, ran, and came back as git exit 128 "invalid object" — which
    /// reads as a bad SHA, so the model retried with *different refs* three
    /// times instead of dropping the pipe. Name the real constraint up front.
    #[test]
    fn blocks_pipes_and_chaining() {
        for cmd in [
            "git show abc123:src/a.cs | sed -n 1,10p",
            "git log --oneline | head -5",
            "ls && cat foo",
            "ls ; cat foo",
            "cat a || cat b",
        ] {
            let err = validate(&toks(cmd)).expect_err(cmd);
            assert!(
                err.contains("no shell"),
                "`{cmd}` should explain there's no shell, got: {err}"
            );
        }
    }

    #[test]
    fn blocks_redirection() {
        for cmd in [
            "git show abc123:src/a.cs > out.cs",
            "git show abc123:src/a.cs >out.cs",
            "git show abc123:src/a.cs >> out.cs",
            "cat foo < bar",
        ] {
            assert!(validate(&toks(cmd)).is_err(), "should reject: {cmd}");
        }
    }

    /// `> /tmp/out.cs` used to be rejected as "Absolute path … use a path
    /// relative to the source directory", which is the wrong reason and invites
    /// a retry with `> out.cs` that fails just as confusingly.
    #[test]
    fn redirect_to_absolute_path_reports_the_redirect_not_the_path() {
        let err = validate(&toks("git show abc123:src/a.cs > /tmp/out.cs")).unwrap_err();
        assert!(err.contains("no shell"), "got: {err}");
        assert!(!err.contains("Absolute path"), "got: {err}");
    }

    /// A command that breaks two rules at once reports the shell syntax first.
    /// That ordering is deliberate — it's what makes `> /tmp/out.cs` say
    /// "redirect" instead of the misleading "use a relative path" — and the
    /// absolute path is still refused on the retry.
    #[test]
    fn reports_shell_syntax_before_the_absolute_path() {
        let err = validate(&toks(r#"find / -iname "SharediSDK*.dll" 2>/dev/null | head -5"#))
            .unwrap_err();
        assert!(err.contains("no shell"), "got: {err}");

        let err = validate(&toks(r#"find / -iname "SharediSDK*.dll""#)).unwrap_err();
        assert!(err.contains("Absolute path"), "got: {err}");
    }

    #[test]
    fn blocks_command_substitution() {
        assert!(validate(&toks("git log $(whoami)")).is_err());
        assert!(validate(&toks("cat `ls`")).is_err());
    }

    #[test]
    fn blocks_fd_redirection() {
        assert!(validate(&toks("find . -name x 2>/dev/null")).is_err());
    }

    /// A metacharacter INSIDE a quoted arg is ordinary data — a regex
    /// alternation, a glob brace — not shell syntax. Rejecting these would
    /// break the most common legitimate search.
    #[test]
    fn allows_metacharacters_inside_arguments() {
        assert!(validate(&toks(r#"rg "class A|class B" src"#)).is_ok());
        assert!(validate(&toks(r#"grep -n "foo|bar" src"#)).is_ok());
        assert!(validate(&toks("git log --grep=fix|feat")).is_ok());
        assert!(validate(&toks("git show abc123^:src/a.cs")).is_ok());
        assert!(validate(&toks("git diff a..b -- src/a.cs")).is_ok());
    }

    fn toks(s: &str) -> Vec<String> {
        tokenize(s).unwrap()
    }

    #[test]
    fn leaves_output_under_the_cap_alone() {
        assert!(clip_output("small\n").is_none());
        assert!(clip_output(&"a\n".repeat(OUTPUT_CAP / 2)).is_none());
    }

    /// Head-only truncation drops the end of a `git log` / `git diff`, which
    /// reads as "the range ended here". Both ends have to survive.
    #[test]
    fn keeps_both_ends_of_oversized_output() {
        let body: String = (0..4000).map(|i| format!("line {i}\n")).collect();
        let text = format!("FIRST_LINE\n{body}LAST_LINE\n");
        assert!(text.len() > OUTPUT_CAP);

        let out = clip_output(&text).expect("oversized output should clip");
        assert!(out.starts_with("FIRST_LINE\n"), "head lost");
        assert!(out.ends_with("LAST_LINE\n"), "tail lost");
        assert!(out.contains("omitted from the middle"), "no elision marker");
        assert!(out.contains("narrow the command"), "no recovery hint");
        assert!(out.len() <= OUTPUT_CAP + 256, "got {} bytes", out.len());
    }

    /// The cuts land on line breaks, so the marker sits on its own row rather
    /// than splicing two half-lines together.
    #[test]
    fn cuts_on_line_boundaries() {
        let text: String = (0..4000).map(|i| format!("line {i}\n")).collect();
        let out = clip_output(&text).unwrap();
        for line in out.lines() {
            assert!(
                line.starts_with("line ") || line.starts_with('…'),
                "spliced a partial line: {line:?}"
            );
        }
    }

    #[test]
    fn clips_multibyte_output_on_a_char_boundary() {
        // No line breaks, so the snap can't help and the cut lands mid-`é`
        // unless the char-boundary walk catches it.
        let text = "é".repeat(OUTPUT_CAP);
        let out = clip_output(&text).unwrap();
        assert!(out.starts_with('é') && out.ends_with('é'));
        assert!(out.contains("omitted from the middle"));
    }
}
