use ignore::WalkBuilder;
use serde::Serialize;

use super::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

#[derive(Serialize)]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// True if the scan stopped early (entry budget or hit cap reached).
    pub truncated: bool,
}

/// Hard cap on entries the walker is allowed to visit before bailing. Protects
/// against pathological roots like $HOME where there's no .gitignore and the
/// tree is effectively unbounded.
const MAX_SCANNED: usize = 50_000;

/// Directory names pruned unconditionally — they're rarely useful in a
/// file-explorer search and they dominate scan time when present.
const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

#[tauri::command]
pub fn fs_search(
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
    max_depth: Option<usize>,
) -> Result<SearchResult, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let cap = limit.unwrap_or(200).min(1000);
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let mut out: Vec<SearchHit> = Vec::with_capacity(cap.min(64));
    let mut scanned: usize = 0;
    let mut truncated = false;

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        // Optional depth bound. Omitted by callers => unlimited (the
        // MAX_SCANNED budget + PRUNE_DIRS still cap pathological roots).
        .max_depth(max_depth.map(|d| d.clamp(1, 16)))
        .filter_entry(|dent| {
            // Prune known-heavy dirs even when no .gitignore is present (e.g.
            // searching from $HOME).
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        if out.len() >= cap {
            truncated = true;
            break;
        }
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if !rel.to_lowercase().contains(&q) {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(SearchHit {
            path: to_canon(path),
            rel,
            name,
            is_dir,
        });
    }

    // Rank: filename matches first, then shorter relative paths.
    out.sort_by(|a, b| {
        let an = a.name.to_lowercase().contains(&q);
        let bn = b.name.to_lowercase().contains(&q);
        bn.cmp(&an).then(a.rel.len().cmp(&b.rel.len()))
    });

    Ok(SearchResult {
        hits: out,
        truncated,
    })
}

#[derive(Serialize)]
pub struct ListFilesResult {
    pub files: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub fn fs_list_files(
    root: String,
    limit: Option<usize>,
    max_depth: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<ListFilesResult, String> {
    const DEFAULT_LIMIT: usize = 2_000;
    const HARD_LIMIT: usize = 10_000;
    const DEFAULT_DEPTH: usize = 8;
    const HARD_DEPTH: usize = 16;

    let cap = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, HARD_LIMIT);
    let depth = max_depth.unwrap_or(DEFAULT_DEPTH).clamp(1, HARD_DEPTH);
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(depth))
        .filter_entry(|dent| {
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    let mut files: Vec<String> = Vec::with_capacity(cap.min(256));
    let mut scanned: usize = 0;
    let mut truncated = false;

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let is_file = dent.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        files.push(rel);
        if files.len() >= cap {
            truncated = true;
            break;
        }
    }

    files.sort_by_key(|a| a.to_lowercase());
    Ok(ListFilesResult { files, truncated })
}

/// Resolve a citation/path the model (or a work-item link) emitted into a real
/// absolute file path under `root`.
///
/// The model is told to emit repo-relative paths, but it sometimes abbreviates
/// to a bare filename ("ReportDeltaProcess.cs") or a partial path whose prefix
/// doesn't line up with `root`. Naively joining `root + path` then 404s. This
/// command does the honest thing:
///   1. If `path` is already an absolute file, use it.
///   2. Try the direct `root/path` join (the cheap, common case).
///   3. Otherwise walk the tree and find the file whose relative path best
///      matches — preferring a full path-suffix match, then a basename match,
///      then the shortest candidate. Ambiguous basename hits still return the
///      shortest, which is the best guess we can offer.
///
/// Returns `Ok(None)` when nothing plausibly matches, so the caller can fall
/// back to showing the original (broken) path in the not-found hint.
#[tauri::command]
pub fn fs_resolve_source_path(
    root: String,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Option<String>, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Ok(None);
    }

    // 1. Already an absolute, real file? Honour it verbatim.
    {
        let p = std::path::Path::new(raw);
        if p.is_absolute() && p.is_file() {
            return Ok(Some(to_canon(p)));
        }
    }

    // Normalise the needle to forward slashes, no leading separators.
    let needle = raw.replace('\\', "/");
    let needle = needle.trim_start_matches('/').to_string();
    if needle.is_empty() {
        return Ok(None);
    }
    let needle_lower = needle.to_lowercase();
    let base_lower = needle_lower.rsplit('/').next().unwrap_or(&needle_lower).to_string();

    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Ok(None);
    }

    // 2. Direct join — the correct-relative-path fast path.
    {
        let candidate = root_path.join(&needle);
        if candidate.is_file() {
            return Ok(Some(to_canon(&candidate)));
        }
    }

    // 3. Walk and rank. Higher score wins; ties break on the shorter rel path.
    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .filter_entry(|dent| {
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    let mut best: Option<(u8, usize, String)> = None; // (score, rel_len, abs)
    let mut scanned: usize = 0;
    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            break;
        }
        let is_file = dent.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let p = dent.path();
        let rel = match p.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        let rel_lower = rel.to_lowercase();
        let score = if rel_lower == needle_lower {
            3
        } else if rel_lower.ends_with(&format!("/{needle_lower}")) {
            2
        } else if rel_lower.rsplit('/').next() == Some(base_lower.as_str()) {
            1
        } else {
            0
        };
        if score == 0 {
            continue;
        }
        let take = match &best {
            None => true,
            Some((bs, blen, _)) => score > *bs || (score == *bs && rel.len() < *blen),
        };
        if take {
            best = Some((score, rel.len(), to_canon(p)));
            // A perfect full-path match can't be beaten; stop early.
            if score == 3 {
                break;
            }
        }
    }

    Ok(best.map(|(_, _, abs)| abs))
}
