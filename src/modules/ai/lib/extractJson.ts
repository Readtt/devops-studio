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

/** Pull the complete `{…}` elements out of `"key": [ … ]` in text that may be
 *  CUT OFF anywhere — the shape a `finish: length` response leaves behind.
 *  `JSON.parse` on such text throws and salvages nothing, so a run that emitted
 *  four complete cases and half a fifth used to hand back an empty batch; this
 *  walks the array element-by-element (string- and escape-aware, so braces
 *  inside values don't fool it) and keeps every element that closed, silently
 *  dropping the one the cut landed in. Works on complete arrays too (it just
 *  stops at the `]`), which is what lets one salvager serve both "truncated"
 *  and "parsed but item-wise invalid". Returns [] when the key isn't followed
 *  by an object array — this understands exactly the batch shapes our surfaces
 *  emit, nothing more general. */
export function completeItemsOfTruncatedArray(
  text: string,
  key: string,
): unknown[] {
  const keyToken = `"${key}"`;
  let best: unknown[] = [];
  let from = 0;
  // Every occurrence is considered, not just the first, and the LAST one that
  // yields items wins. Returning on the first `"cases": [` silently threw away
  // the batch whenever the answer opened with a same-keyed array — a restated
  // schema, an echo of the suite's existing cases — and handed back the example
  // as the run's output. Last-wins is the right tie-break for what actually
  // reaches this function: it only runs when JSON.parse failed, which in
  // practice means the text was CUT OFF, and a cut lands at the end. Anything
  // preceding the real payload is preamble. An occurrence that yields nothing
  // (a trailing `"cases": [` with no complete object after it) can't displace a
  // good earlier one.
  while (from < text.length) {
    const k = text.indexOf(keyToken, from);
    if (k < 0) break;
    from = k + keyToken.length;
    // Skip occurrences of the key that aren't followed by `: [` — e.g. the
    // model mentioning the field name inside a prose string.
    let i = from;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ":") continue;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "[") continue;
    const items = scanArrayItems(text, i + 1);
    if (items.length > 0) best = items;
  }
  return best;
}

function scanArrayItems(text: string, start: number): unknown[] {
  const items: unknown[] = [];
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    if (c === "]") break; // array closed cleanly — nothing was truncated
    if (c !== "{") break; // not an object array — not a shape we salvage
    const end = scanBalancedObject(text, i);
    if (end < 0) break; // input ended mid-object — the cut element, dropped
    try {
      items.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      // A balanced-but-invalid slice means the text is malformed beyond
      // truncation; stop rather than guess at where the next element starts.
      break;
    }
    i = end + 1;
  }
  return items;
}

/** Index of the bracket closing the object that opens at `start`, or -1 when
 *  the input ends first (the truncation case). */
function scanBalancedObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
