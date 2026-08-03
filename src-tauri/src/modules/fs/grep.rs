use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;

/// Per-hit cap on returned line text, in bytes. Claude Code's figure. A
/// committed lockfile, minified bundle, `.map` or generated designer file is
/// one line of megabytes — a pattern hitting inside one used to return that
/// entire line once per hit, which is how an AI run overflowed a 1M-token
/// window in a single tool call.
const LINE_TEXT_CAP: usize = 2_000;

#[derive(Serialize)]
pub struct GrepHit {
    pub path: String,
    pub rel: String,
    pub line: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct GrepResponse {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

/// Clip an over-long matched line to `LINE_TEXT_CAP`, keeping the window
/// CENTRED ON THE MATCH. Head-clipping a 500 KB minified line returns 2 KB
/// that doesn't contain the match at all — a hit the model can see but not
/// read, which is worse than reporting no hit. The `UTF8` sink yields only
/// `(line_num, text)`, so the offset comes from re-running the matcher over
/// the line. The `…[+N chars]` markers tell the model to `read_file` the rest.
fn clip_line(line: &str, matcher: &impl Matcher) -> String {
    if line.len() <= LINE_TEXT_CAP {
        return line.to_string();
    }
    let (m_start, m_end) = match matcher.find(line.as_bytes()).ok().flatten() {
        Some(m) => (m.start(), m.end()),
        None => (0, 0),
    };
    let m_len = m_end - m_start;

    let mut start = m_start.saturating_sub(LINE_TEXT_CAP.saturating_sub(m_len) / 2);
    // Clamp so the window still holds the whole match (a match longer than the
    // cap keeps its head), then so it stays inside the line.
    start = start.max(m_end.saturating_sub(LINE_TEXT_CAP)).min(m_start);
    start = start.min(line.len() - LINE_TEXT_CAP);
    while start > 0 && !line.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + LINE_TEXT_CAP).min(line.len());
    if m_len <= LINE_TEXT_CAP {
        end = end.max(m_end);
    }
    while end < line.len() && !line.is_char_boundary(end) {
        end += 1;
    }

    let mut out = String::with_capacity(LINE_TEXT_CAP + 64);
    if start > 0 {
        out.push_str(&elision(line[..start].chars().count()));
    }
    out.push_str(&line[start..end]);
    if end < line.len() {
        out.push_str(&elision(line[end..].chars().count()));
    }
    out
}

fn elision(chars: usize) -> String {
    format!("…[+{chars} chars]")
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("bad glob {p:?}: {e}"))?;
        b.add(g);
    }
    let set = b.build().map_err(|e| format!("globset build: {e}"))?;
    Ok(Some(set))
}

#[tauri::command]
pub fn fs_grep(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let globs = build_globset(glob.as_deref().unwrap_or(&[]))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build_parallel();

    let hits: Arc<Mutex<Vec<GrepHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    walker.run(|| {
        let matcher = matcher.clone();
        let globs = globs.clone();
        let hits = hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.clone();

        Box::new(move |dent_res| {
            if truncated.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let dent = match dent_res {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => return WalkState::Continue,
            };
            if let Some(set) = globs.as_ref() {
                if !set.is_match(&rel) {
                    return WalkState::Continue;
                }
            }
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }

            scanned.fetch_add(1, Ordering::Relaxed);

            let abs = to_canon(path);
            let rel_clone = rel.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();

            let _ = searcher.search_path(
                &matcher,
                path,
                UTF8(|line_num, text| {
                    let line_text = clip_line(text.trim_end_matches('\n'), &matcher);
                    let mut guard = hits.lock().unwrap();
                    if guard.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    guard.push(GrepHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        text: line_text,
                    });
                    Ok(true)
                }),
            );

            WalkState::Continue
        })
    });

    let final_hits = Arc::try_unwrap(hits)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    Ok(GrepResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    })
}

#[derive(Serialize)]
pub struct GlobHit {
    pub path: String,
    pub rel: String,
}

#[derive(Serialize)]
pub struct GlobResponse {
    pub hits: Vec<GlobHit>,
    pub truncated: bool,
}

#[tauri::command]
pub fn fs_glob(
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GlobResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results.unwrap_or(500).clamp(1, HARD_MAX_RESULTS);

    let glob = Glob::new(&pattern).map_err(|e| format!("bad glob: {e}"))?;
    let mut gb = GlobSetBuilder::new();
    gb.add(glob);
    let set = gb.build().map_err(|e| format!("globset build: {e}"))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut hits: Vec<GlobHit> = Vec::new();
    let mut truncated = false;
    for dent in walker.flatten() {
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if !set.is_match(&rel) {
            continue;
        }
        hits.push(GlobHit {
            path: to_canon(path),
            rel,
        });
    }

    Ok(GlobResponse { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn grep_in(dir: &std::path::Path, pattern: &str) -> GrepResponse {
        fs_grep(
            pattern.to_string(),
            dir.to_string_lossy().to_string(),
            None,
            None,
            None,
            None,
        )
        .expect("grep over a real directory should succeed")
    }

    fn write_one_line(name: &str, line: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(name), format!("{line}\n")).unwrap();
        dir
    }

    fn head_elided(text: &str) -> bool {
        text.starts_with("…[+") && text[..40.min(text.len())].contains(" chars]")
    }

    fn tail_elided(text: &str) -> bool {
        text.ends_with(" chars]")
    }

    /// The bug this cap exists for: a repo with a committed minified bundle /
    /// lockfile returns megabytes per hit. Clipping is only useful if the
    /// clipped window still CONTAINS the match — a head clip (`line[..2000]`)
    /// returns 2 KB of filler and the model sees a hit it cannot read.
    #[test]
    fn clips_a_long_line_around_the_match_not_the_head() {
        let filler = "x".repeat(200_000);
        let dir = write_one_line("data.txt", &format!("{filler}NEEDLE_TOKEN{filler}"));

        let out = grep_in(dir.path(), "NEEDLE_TOKEN");
        assert_eq!(out.hits.len(), 1);
        let text = &out.hits[0].text;

        assert!(
            text.contains("NEEDLE_TOKEN"),
            "a clipped hit must still contain its match; got {} bytes starting {:?}",
            text.len(),
            &text[..text.len().min(40)]
        );
        assert!(
            head_elided(text),
            "expected a head elision marker, got {:?}",
            &text[..text.len().min(40)]
        );
        assert!(
            tail_elided(text),
            "expected a tail elision marker, got {:?}",
            &text[text.len().saturating_sub(40)..]
        );
        // Cap + both markers, not 400 KB.
        assert!(text.len() < LINE_TEXT_CAP + 100, "got {} bytes", text.len());
    }

    /// A match at the very end is the case a head clip fails hardest at, and
    /// the case that must not grow a spurious tail marker.
    #[test]
    fn keeps_a_match_at_the_end_of_a_long_line() {
        let filler = "x".repeat(200_000);
        let dir = write_one_line("data.txt", &format!("{filler}NEEDLE_TOKEN"));

        let out = grep_in(dir.path(), "NEEDLE_TOKEN");
        let text = &out.hits[0].text;
        assert!(text.contains("NEEDLE_TOKEN"), "match lost off the tail");
        assert!(head_elided(text), "expected a head elision marker");
        assert!(
            text.ends_with("NEEDLE_TOKEN"),
            "nothing follows the match, so nothing should be elided after it"
        );
    }

    #[test]
    fn keeps_a_match_at_the_start_of_a_long_line() {
        let filler = "x".repeat(200_000);
        let dir = write_one_line("data.txt", &format!("NEEDLE_TOKEN{filler}"));

        let out = grep_in(dir.path(), "NEEDLE_TOKEN");
        let text = &out.hits[0].text;
        assert!(text.starts_with("NEEDLE_TOKEN"), "got {:?}", &text[..40]);
        assert!(tail_elided(text), "expected a tail elision marker");
    }

    /// Slicing a byte window out of a multibyte line panics unless every edge
    /// lands on a char boundary — and the midpoint bias lands mid-char here.
    #[test]
    fn clips_multibyte_lines_on_a_char_boundary() {
        let filler = "é".repeat(100_000);
        let dir = write_one_line("data.txt", &format!("{filler}NEEDLE{filler}"));

        let out = grep_in(dir.path(), "NEEDLE");
        let text = &out.hits[0].text;
        assert!(text.contains("NEEDLE"));
        assert!(text.contains('é'), "context around the match was dropped");
    }

    /// A match longer than the cap can't be shown whole. Show its HEAD — the
    /// window opens where the match does — rather than an arbitrary slice of
    /// the middle, and mark both elisions.
    #[test]
    fn clips_a_match_longer_than_the_cap_to_its_head() {
        let huge = "N".repeat(50_000);
        let dir = write_one_line("data.txt", &format!("prefix{huge}suffix"));

        let out = grep_in(dir.path(), "N+");
        let text = &out.hits[0].text;
        assert!(head_elided(text), "got {:?}", &text[..text.len().min(20)]);
        assert!(
            text.contains(&"N".repeat(LINE_TEXT_CAP - 1)),
            "the window should open at the match, not somewhere inside it"
        );
        assert!(tail_elided(text), "expected a tail elision marker");
        assert!(text.len() < LINE_TEXT_CAP + 100, "got {} bytes", text.len());
    }

    #[test]
    fn leaves_ordinary_lines_untouched() {
        let dir = write_one_line("data.txt", "const NEEDLE = 1;");
        let out = grep_in(dir.path(), "NEEDLE");
        assert_eq!(out.hits[0].text, "const NEEDLE = 1;");
    }
}
