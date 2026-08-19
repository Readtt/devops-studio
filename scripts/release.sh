#!/usr/bin/env bash
# scripts/release.sh — cut a new DevOps Studio release.
#
# What it does:
#   1. Validates working tree is clean and on `main`.
#   2. Opens $EDITOR (or nano) for release notes — or accepts --notes-file PATH.
#   3. Prepends an entry to CHANGELOG.md using the notes you wrote.
#   4. Bumps version in package.json, src-tauri/tauri.conf.json,
#      src-tauri/Cargo.toml, and src-tauri/Cargo.lock.
#   5. Commits all of the above with message `chore(release): <version>`.
#   6. Tags `vX.Y.Z` (annotated, with the notes as the message).
#   7. Pushes main + the tag.
#
# After the push:
#   - The Release workflow builds Windows + Linux + macOS installers, signs
#     every updater artifact with the private key in GitHub Secrets, and
#     auto-publishes a GitHub release with the notes from CHANGELOG.md as
#     the release body.
#   - In-app updater on any older install will see the new version on its
#     next 30-minute check (or relaunch).
#
# Usage:
#   ./scripts/release.sh 0.1.2
#   ./scripts/release.sh 0.1.3 --notes-file my-release-notes.md
#   ./scripts/release.sh 0.2.0-rc.1 --no-edit  # use a stub entry, push, write notes later
#
# Requires: bash, awk, sed, git. (gh CLI optional — used only to surface
# the workflow run URL at the end.)

set -euo pipefail

REPO_SLUG="Readtt/devops-studio"

die() { echo "error: $*" >&2; exit 1; }
note() { printf '\033[1;36m→\033[0m %s\n' "$*"; }

# ---- Args -------------------------------------------------------------------

VERSION="${1:-}"
[[ -z "$VERSION" ]] && die "usage: $0 <version> [--notes-file PATH] [--no-edit]"
shift

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  die "version must be semver (e.g. 0.1.2 or 0.2.0-rc.1), got: $VERSION"
fi

TAG="v$VERSION"
NOTES_FILE=""
NO_EDIT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes-file) NOTES_FILE="${2:-}"; shift 2 ;;
    --no-edit) NO_EDIT=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

# Always run from repo root regardless of where the user invoked us from.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git repo"
cd "$REPO_ROOT"

# ---- Pre-flight checks ------------------------------------------------------

[[ -n "$(git status --porcelain)" ]] && {
  git status --short
  die "working tree is dirty. Commit or stash, then retry."
}

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "main" ]] && die "must be on 'main' branch (currently on '$BRANCH')"

note "pulling latest main…"
git pull --ff-only origin main

git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists"

# ---- Release notes ----------------------------------------------------------

CLEANUP_NOTES=""
if [[ -n "$NOTES_FILE" ]]; then
  [[ -f "$NOTES_FILE" ]] || die "notes file not found: $NOTES_FILE"
  NOTES_PATH="$NOTES_FILE"
elif [[ $NO_EDIT -eq 1 ]]; then
  # Stub entry — user edits CHANGELOG.md later and amends the commit.
  NOTES_PATH="$(mktemp)"
  CLEANUP_NOTES="$NOTES_PATH"
  cat > "$NOTES_PATH" <<EOF
### Changed

- _Release notes pending — edit CHANGELOG.md and amend the commit before tagging._
EOF
else
  NOTES_PATH="$(mktemp)"
  CLEANUP_NOTES="$NOTES_PATH"
  cat > "$NOTES_PATH" <<EOF
# Release notes for $TAG
#
# Lines starting with # will be stripped (this header included).
# Follow Keep a Changelog conventions — use level-3 (###) headings like:
#
#   ### Added
#   - …
#
#   ### Fixed
#   - …
#
#   ### Changed
#   - …
#
#   ### Removed
#   - …
#
# Save and close the editor when you're done. Quit without saving to abort.

### Added

### Fixed

### Changed

EOF
  "${EDITOR:-nano}" "$NOTES_PATH"
fi

# Strip template comment lines ("# …" and a lone "#") but KEEP markdown
# headings ("## …", "### …") — `grep -v '^#'` used to eat the section
# headings out of a --notes-file. Then trim leading/trailing blank runs.
NOTES="$(grep -vE '^#( |$)' "$NOTES_PATH" | awk 'BEGIN{blank=1} /^[[:space:]]*$/{ if (blank) next; print; next } { blank=0; print }' | awk 'NR>1{print prev} {prev=$0} END{ if (prev!~/^[[:space:]]*$/) print prev }')"

if [[ -z "$(echo "$NOTES" | tr -d '[:space:]')" ]]; then
  [[ -n "$CLEANUP_NOTES" ]] && rm -f "$CLEANUP_NOTES"
  die "release notes are empty — nothing to ship"
fi

# ---- CHANGELOG.md update ----------------------------------------------------

DATE_UTC="$(date -u +%Y-%m-%d)"
ENTRY="## [$VERSION] - $DATE_UTC

$NOTES"

if [[ ! -f CHANGELOG.md ]]; then
  cat > CHANGELOG.md <<EOF
# Changelog

All notable changes to DevOps Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

$ENTRY
EOF
else
  # Insert the new entry immediately before the first existing version
  # heading (## [). If there's no existing heading, append to end.
  # Via ENVIRON, not -v: awk runs backslash-escape processing over a -v
  # value, so notes mentioning a Windows path lost their separators and had
  # the surrounding UTF-8 corrupted into replacement characters. 0.22.0
  # shipped with `C:\…\other-repo\.git` mangled this way.
  RELEASE_ENTRY="$ENTRY" awk '
    BEGIN { entry = ENVIRON["RELEASE_ENTRY"]; inserted = 0 }
    !inserted && /^## \[/ {
      print entry
      print ""
      inserted = 1
    }
    { print }
    END {
      if (!inserted) {
        print ""
        print entry
      }
    }
  ' CHANGELOG.md > CHANGELOG.md.tmp
  mv CHANGELOG.md.tmp CHANGELOG.md
fi

# ---- Version bumps ----------------------------------------------------------

note "bumping versions to $VERSION…"

bump_json() {
  local file="$1"
  awk -v ver="$VERSION" '
    !done && /"version"[[:space:]]*:[[:space:]]*"[^"]+"/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]+"/, "\"version\": \"" ver "\"")
      done = 1
    }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

bump_cargo_toml() {
  local file="$1"
  awk -v ver="$VERSION" '
    !done && /^version[[:space:]]*=[[:space:]]*"[^"]+"/ {
      sub(/version[[:space:]]*=[[:space:]]*"[^"]+"/, "version = \"" ver "\"")
      done = 1
    }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

bump_cargo_lock() {
  local file="$1"
  awk -v ver="$VERSION" '
    found && /^version[[:space:]]*=[[:space:]]*"[^"]+"/ {
      sub(/version[[:space:]]*=[[:space:]]*"[^"]+"/, "version = \"" ver "\"")
      found = 0
    }
    /^name[[:space:]]*=[[:space:]]*"devops-studio"$/ { found = 1 }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

bump_json package.json
bump_json src-tauri/tauri.conf.json
bump_cargo_toml src-tauri/Cargo.toml
bump_cargo_lock src-tauri/Cargo.lock

# Sanity checks
grep -q "\"version\": \"$VERSION\"" package.json \
  || die "package.json version bump failed"
grep -q "\"version\": \"$VERSION\"" src-tauri/tauri.conf.json \
  || die "tauri.conf.json version bump failed"
grep -q "^version = \"$VERSION\"$" src-tauri/Cargo.toml \
  || die "Cargo.toml version bump failed"
awk '/^name = "devops-studio"$/{f=1; next} f && /^version = /{print; exit}' src-tauri/Cargo.lock \
  | grep -q "\"$VERSION\"" \
  || die "Cargo.lock version bump failed"

# ---- Commit + tag + push ----------------------------------------------------

git add CHANGELOG.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock

note "committing release $VERSION…"
git commit -m "chore(release): $VERSION

$NOTES"

note "tagging $TAG…"
git tag -a "$TAG" -m "$NOTES"

note "pushing main + $TAG…"
git push origin main
git push origin "$TAG"

[[ -n "$CLEANUP_NOTES" ]] && rm -f "$CLEANUP_NOTES"

# ---- Tail the workflow if gh CLI is available -------------------------------

echo
echo "✓ Released $TAG."
echo "  CHANGELOG.md updated, version bumped, tag pushed."
echo

if command -v gh >/dev/null 2>&1; then
  sleep 3
  RUN_ID="$(gh run list --repo "$REPO_SLUG" --workflow=release.yml --event=push --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" ]]; then
    echo "  Release workflow #$RUN_ID running."
    echo "    Watch live:    gh run watch $RUN_ID --repo $REPO_SLUG"
    echo "    Browser:       https://github.com/$REPO_SLUG/actions/runs/$RUN_ID"
  else
    echo "  Watch the run at: https://github.com/$REPO_SLUG/actions"
  fi
  echo "  Release will auto-publish at: https://github.com/$REPO_SLUG/releases/tag/$TAG"
else
  echo "  (Install the gh CLI to see workflow status here.)"
  echo "  Watch the run at: https://github.com/$REPO_SLUG/actions"
fi
