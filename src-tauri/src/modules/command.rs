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
//! 3. No paths out of the repo. Args can't start at `/`, a UNC root, or a
//!    Windows drive, and no arg may carry a `..` segment — so reads stay in the
//!    repo the call names rather than ranging over the disk or over a sibling
//!    repo the user excluded from the run's scope.
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
///
/// Allowed is not the same as PRESENT: only `git` is guaranteed on every
/// machine this app runs on. Everything after it here is absent from a stock
/// Windows PATH, and `find` / `tree` are worse than absent — see
/// `shadowed_program_hint` and `unavailable_program_hint`, which turn both
/// cases into an error that names a working alternative.
const ALLOWED_PROGRAMS: &[&str] = &[
    "git", "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "tree", "pwd",
];

/// git subcommands that only READ. The test for membership is "has no write
/// form at all" — branch / tag / remote / config / stash / worktree are out
/// because one flag turns each into a mutation (`git branch -d`), and we avoid
/// brittle per-flag analysis by simply not allowing them. `for-each-ref` and
/// `show-branch` are the read-only way to ask what branch / tag those would
/// have answered. `ls-remote` is also read-only but stays out: it goes to the
/// NETWORK, which can hang the call on a credential prompt.
///
/// git is the one program here that is present on every machine this app runs
/// on (the app itself shells out to it), so it carries the weight that `ls` /
/// `cat` / `grep` can't on Windows — see `unavailable_program_hint`.
const GIT_READONLY_SUBCOMMANDS: &[&str] = &[
    // history + object inspection
    "log", "show", "diff", "status", "blame", "annotate", "rev-parse",
    "shortlog", "describe", "ls-files", "ls-tree", "cat-file", "show-ref",
    "rev-list", "name-rev", "reflog", "grep", "whatchanged", "merge-base",
    "cherry",
    // refs, without the write forms of branch / tag
    "for-each-ref", "show-branch",
    // diff plumbing: files-in-a-commit, tree-vs-index, series-vs-series
    "diff-tree", "diff-index", "diff-files", "range-diff",
    // path attribute queries: is this ignored, what filters apply
    "check-ignore", "check-attr",
    // signature checks — commit review asks about provenance
    "verify-commit", "verify-tag",
    // so a run can check the build before reaching for a newer flag
    "version",
];

/// git flags that WRITE or EXECUTE from inside an otherwise read-only
/// subcommand, so the subcommand allowlist alone doesn't see them:
/// `git diff --output=<file>` writes a file, and `git grep -O<cmd>` /
/// `--open-files-in-pager` runs a program. Matched glued (`--output=x`) and
/// separated (`--output x`) alike.
const GIT_DANGEROUS_FLAGS: &[&str] = &["--output", "-O", "--open-files-in-pager"];

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

/// On Windows these two names resolve to unrelated Microsoft binaries that
/// only share a name: `find.exe` searches files for a STRING (`find "x" f.txt`)
/// and `tree.com` takes `/F`. So `find . -name "*.ts"` doesn't fail as
/// "wrong program", it fails as `FIND: Parameter format not correct` — which
/// reads like a bad argument and invites three more attempts in different
/// syntaxes. No PATH fixes this, so refuse before spawning and name the tool
/// that does the job.
#[cfg(windows)]
fn shadowed_program_hint(program: &str) -> Option<String> {
    let alt = match program {
        "find" => "the list_files tool, or `git ls-files`",
        "tree" => "the list_files tool",
        _ => return None,
    };
    Some(format!(
        "On Windows `{program}` is Microsoft's `{program}`, not the POSIX one — same name, \
         different flags, so it can't answer this. Use {alt} instead."
    ))
}

#[cfg(not(windows))]
fn shadowed_program_hint(_program: &str) -> Option<String> {
    None
}

/// What to reach for when an allowed program isn't installed. Six of these
/// are absent from a stock Windows PATH: Git for Windows ships `ls`, `cat`,
/// `head`, `tail`, `wc` and `grep` in `usr\bin`, which its default install
/// leaves off the PATH. Launching the app from Git Bash puts them back, which
/// is precisely why this went unnoticed in development — it works in
/// `pnpm tauri dev` and not in the shipped app. A bare "program not found"
/// invites a retry in another dialect that fails the same way, so every
/// answer here names something guaranteed to exist: a tool, or git.
fn unavailable_program_hint(program: &str) -> &'static str {
    match program {
        "ls" | "find" | "tree" => "Use the list_files tool, or `git ls-files`.",
        "cat" | "head" | "tail" | "wc" => {
            "Use the read_file tool (it takes offset/limit to window a big file), \
             or `git show HEAD:<path>`."
        }
        "grep" | "rg" => "Use the grep tool, or `git grep <pattern>`.",
        _ => "Prefer git — it's the one program guaranteed to be here.",
    }
}

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
    if let Some(hint) = shadowed_program_hint(&program) {
        return Err(hint);
    }
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

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "`{program}` isn't installed on this machine. {}",
                unavailable_program_hint(&program)
            )
        } else {
            format!("Couldn't run `{program}`: {e}")
        }
    })?;

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
    for a in args {
        if climbs_out(a) {
            return Err(format!(
                "`{a}` climbs out of the repo with `..` — paths are relative to the repo the \
                 command runs in. To read another repo, call again with that `repo`."
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
        for a in args {
            if is_git_dangerous_flag(a) {
                return Err(format!(
                    "git `{a}` isn't allowed — it writes a file or runs a program, which this \
                     read-only shell never does. Let the output come back as text instead."
                ));
            }
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

/// True when a token IS one of the write/exec git flags, glued (`--output=x`)
/// or bare (`--output x`). `-O` is matched as a prefix because git grep takes
/// its pager glued to it (`-O"code -"`).
fn is_git_dangerous_flag(s: &str) -> bool {
    GIT_DANGEROUS_FLAGS.iter().any(|f| {
        s == *f
            || (f.starts_with("--") && s.starts_with(&format!("{f}=")))
            || (!f.starts_with("--") && s.starts_with(f))
    })
}

/// True when an arg carries a `..` PATH SEGMENT, which walks out of the repo
/// the command was told to run in — and so out of the run's repo scope, since
/// scope is enforced by which repo we `current_dir` into.
///
/// Tested per segment rather than as a substring because `..` is also git's
/// range syntax: `git diff a..b`, `git log origin/main..HEAD` are ordinary
/// read-only commands and must keep working. Those have no segment that IS
/// `..`; `../other-repo/appsettings.json` does.
///
/// Split on `=` first, because git takes paths as glued flag values: the
/// segments of `--git-dir=../other/.git` are `--git-dir=..`, `other`, `.git`
/// — not one of them IS `..`, so a plain segment test waves through the one
/// form that redirects the WHOLE command at another repo.
fn climbs_out(s: &str) -> bool {
    s.split('=')
        .any(|part| part.split(['/', '\\']).any(|seg| seg == ".."))
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

    /// Every subcommand added to the read-only list has to have NO write form
    /// at all — that's the membership test, not "we couldn't think of a way to
    /// misuse it".
    #[test]
    fn allows_the_added_readonly_git_subcommands() {
        for cmd in [
            "git check-ignore -v dist/bundle.js",
            "git check-attr diff -- src/a.cs",
            "git for-each-ref --sort=-committerdate refs/heads",
            "git show-branch --list",
            "git diff-tree --no-commit-id --name-only -r abc123",
            "git diff-index HEAD",
            "git diff-files",
            "git range-diff main~3..main topic",
            "git annotate src/a.cs",
            "git verify-commit HEAD",
            "git verify-tag v0.1.2",
            "git version",
        ] {
            assert!(validate(&toks(cmd)).is_ok(), "should allow: {cmd}");
        }
    }

    /// The subcommands whose write form is one flag away stay out even though
    /// their READ form would be handy — `for-each-ref` covers what `branch`
    /// and `tag` would have answered. `ls-remote` is read-only but goes to the
    /// network, where a credential prompt can hang the call to the timeout.
    #[test]
    fn still_blocks_write_capable_and_network_subcommands() {
        for cmd in [
            "git branch -d feature",
            "git tag -d v0.1.2",
            "git config user.email hi@example.com",
            "git stash list",
            "git worktree list",
            "git symbolic-ref HEAD refs/heads/main",
            "git bisect start",
            "git ls-remote origin",
        ] {
            assert!(validate(&toks(cmd)).is_err(), "should refuse: {cmd}");
        }
    }

    /// A write hidden INSIDE an allowed subcommand: `--output=` makes `git
    /// diff` write a file and `-O` makes `git grep` run a program, neither of
    /// which the subcommand allowlist can see.
    #[test]
    fn blocks_git_flags_that_write_or_execute() {
        for cmd in [
            "git diff --output=leak.txt",
            "git diff --output leak.txt",
            "git log --output=leak.txt",
            "git grep -Ocode pattern",
            "git grep --open-files-in-pager=code pattern",
        ] {
            assert!(validate(&toks(cmd)).is_err(), "should refuse: {cmd}");
        }
        // Flags that merely start the same way are ordinary reads.
        assert!(validate(&toks("git log --oneline")).is_ok());
        assert!(validate(&toks("git diff --output-indicator-new=+")).is_ok());
    }

    /// `--git-dir=../other/.git` points the WHOLE command at another repo
    /// while looking like a flag, and its path segments are `--git-dir=..`,
    /// `other`, `.git` — not one of them IS `..`, so the segment test alone
    /// waved it through. Splitting on `=` first is what closes it.
    #[test]
    fn blocks_repo_escape_through_a_glued_flag_value() {
        for cmd in [
            "git --git-dir=../other-repo/.git log --oneline",
            "git --git-dir=.. log",
            "git --work-tree=../other-repo status",
        ] {
            let err = validate(&toks(cmd)).expect_err(cmd);
            assert!(err.contains("climbs out"), "{cmd} → {err}");
        }
    }

    /// Windows `find` / `tree` are different programs wearing the same name,
    /// so they're refused up front with the alternative instead of being left
    /// to fail as `FIND: Parameter format not correct`.
    #[cfg(windows)]
    #[test]
    fn windows_refuses_the_shadowed_programs_with_an_alternative() {
        for p in ["find", "tree"] {
            let err = shadowed_program_hint(p).unwrap_or_else(|| panic!("{p} is shadowed"));
            assert!(err.contains("list_files"), "{p} → {err}");
        }
        assert!(shadowed_program_hint("git").is_none());
        assert!(shadowed_program_hint("cat").is_none());
    }

    /// Everywhere else those names ARE the POSIX programs, so nothing is
    /// refused — validation stays platform-independent either way.
    #[cfg(not(windows))]
    #[test]
    fn non_windows_leaves_find_and_tree_alone() {
        assert!(shadowed_program_hint("find").is_none());
        assert!(shadowed_program_hint("tree").is_none());
    }

    /// A missing program has to hand back something that EXISTS, or the model
    /// retries the same idea in a different dialect and burns another step
    /// against the surface's cap.
    #[test]
    fn missing_program_hint_names_a_working_alternative() {
        for p in ["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "pwd"] {
            let hint = unavailable_program_hint(p);
            assert!(
                hint.contains("tool") || hint.contains("git"),
                "`{p}` hint names no alternative: {hint}"
            );
        }
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

    /// The repo the command runs in IS the scope enforcement, so a `..` walks
    /// straight out of it — into a sibling repo the user deselected in the
    /// Repos chips, or anywhere else beside the root.
    #[test]
    fn blocks_paths_that_climb_out_of_the_repo() {
        assert!(validate(&toks("cat ../other-repo/appsettings.json")).is_err());
        assert!(validate(&toks("cat ..\\other-repo\\secrets.json")).is_err());
        assert!(validate(&toks("ls ..")).is_err());
        assert!(validate(&toks("grep -r token src/../../..")).is_err());
        assert!(validate(&toks(r#"cat "../a/b.txt""#)).is_err());
    }

    /// `..` is also git's range syntax, and those are ordinary read-only
    /// commands — the guard is per path SEGMENT for exactly this reason.
    #[test]
    fn still_allows_git_commit_ranges() {
        assert!(validate(&toks("git diff a..b")).is_ok());
        assert!(validate(&toks("git log origin/main..HEAD")).is_ok());
        assert!(validate(&toks("git diff a..b -- src/a.cs")).is_ok());
        assert!(validate(&toks("git log HEAD~3..HEAD --oneline")).is_ok());
        assert!(validate(&toks("cat src/..config/app.json")).is_ok());
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
