// Shared resolver for paths the analyst / bug pipeline hands us. Paths emitted
// by the model and parsed from work-item links are *relative* to the user's
// chosen source directory; the Rust `fs_read_file` handler treats whatever
// it receives literally, so we have to absolutize on the frontend before
// dispatching the open-code-viewer event.
//
// Centralised so a Windows-vs-POSIX separator quirk only needs to be fixed
// once.

const ABS_POSIX = /^\//;
const ABS_WIN = /^[a-zA-Z]:[\\/]/;

/** Returns true when the path is already an absolute filesystem path. */
export function isAbsolutePath(p: string): boolean {
  return ABS_POSIX.test(p) || ABS_WIN.test(p);
}

/** Which separator a path "wants": backslash for Windows-style paths (drive
 *  letter or any backslash present), forward slash otherwise. */
function dominantSeparator(p: string): "\\" | "/" {
  return /\\/.test(p) || /^[a-zA-Z]:/.test(p) ? "\\" : "/";
}

/** Collapse every run of either separator into a single canonical one, so a
 *  joined path never ends up mixed like `C:\repo/sub/file.cs`. Leaves a POSIX
 *  root (`/…`) on forward slashes; a Windows root on backslashes. */
export function normalizeSeparators(p: string): string {
  if (!p) return p;
  return p.replace(/[\\/]+/g, dominantSeparator(p));
}

/** Display form for a resolved path: same canonical separators we resolve to,
 *  so what the user sees matches what's opened (and dedup keys line up). */
export function displaySourcePath(p: string): string {
  return normalizeSeparators(p);
}

/** Join a user-relative file path against the configured sourceRoot. If the
 *  input is already absolute it's returned (separator-normalised) unchanged.
 *  Returns null when no sourceRoot is set — callers should disable the link /
 *  show a hint in that case rather than guess. The result uses ONE separator
 *  style (the sourceRoot's) so paths never render half-`\`, half-`/`. */
export function resolveSourcePath(
  sourceRoot: string | null,
  file: string,
): string | null {
  if (!file) return null;
  if (isAbsolutePath(file)) return normalizeSeparators(file);
  if (!sourceRoot) return null;
  const trimmedRoot = sourceRoot.replace(/[\\/]+$/, "");
  const trimmedFile = file.replace(/^[\\/]+/, "");
  return normalizeSeparators(`${trimmedRoot}/${trimmedFile}`);
}
