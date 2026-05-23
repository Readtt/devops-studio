/**
 * Tiny opaque id generator for in-memory things (pane ids, split ids) that
 * don't need cryptographic guarantees. 9 base36 chars ≈ 47 bits of entropy,
 * plenty for a single session and small enough to be readable in devtools.
 */
export function genId(): string {
  return (
    Math.random().toString(36).slice(2, 7) +
    Math.random().toString(36).slice(2, 6)
  );
}
