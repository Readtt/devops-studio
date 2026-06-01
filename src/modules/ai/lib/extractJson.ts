/** Pull a JSON object out of a model response that may be fenced or wrapped in
 *  prose. Strips a ```json … ``` (or bare ```) fence if present; otherwise
 *  takes from the first `{` to the last `}`. Returns the input unchanged when
 *  no object is found, so the caller's JSON.parse gives the real error.
 *
 *  Shared defensive fallback for the structured surfaces: the runner returns a
 *  validated object on the happy path, and this only runs when it couldn't —
 *  to salvage what the model actually emitted. */
export function extractJsonBlock(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}
