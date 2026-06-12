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

const OUTPUT_CAP: usize = 30_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// Process exit code (-1 if the process was killed / produced no code).
    pub returncode: i32,
    /// Combined stdout + stderr, capped at OUTPUT_CAP chars.
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
    let mut truncated = false;
    if text.len() > OUTPUT_CAP {
        let mut end = OUTPUT_CAP;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        truncated = true;
    }

    Ok(CommandResult {
        returncode: out.status.code().unwrap_or(-1),
        output: text,
        truncated,
    })
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

    fn toks(s: &str) -> Vec<String> {
        tokenize(s).unwrap()
    }
}
