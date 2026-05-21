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

/** Join a user-relative file path against the configured sourceRoot. If the
 *  input is already absolute it's returned unchanged. Returns null when no
 *  sourceRoot is set — callers should disable the link / show a hint in
 *  that case rather than guess. */
export function resolveSourcePath(
  sourceRoot: string | null,
  file: string,
): string | null {
  if (!file) return null;
  if (isAbsolutePath(file)) return file;
  if (!sourceRoot) return null;
  const trimmedRoot = sourceRoot.replace(/[\\/]+$/, "");
  const trimmedFile = file.replace(/^[\\/]+/, "");
  return `${trimmedRoot}/${trimmedFile}`;
}
