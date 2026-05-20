/**
 * Jaro–Winkler similarity for title duplicate detection.
 *
 * Returns a value in [0,1]. We threshold at 0.85 in the review phase: above
 * that we surface a "similar to #1234" hint so the reviewer can decide. Below
 * that we trust the AI's de-duplication (it was told the existing titles).
 */
export function jaroWinkler(a: string, b: string): number {
  const sa = normalize(a);
  const sb = normalize(b);
  if (sa === sb) return 1;
  if (sa.length === 0 || sb.length === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(sa.length, sb.length) / 2) - 1);
  const aMatches = new Array<boolean>(sa.length).fill(false);
  const bMatches = new Array<boolean>(sb.length).fill(false);

  let matches = 0;
  for (let i = 0; i < sa.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, sb.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (sa[i] !== sb[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < sa.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (sa[i] !== sb[k]) transpositions++;
    k++;
  }

  const m = matches;
  const jaro =
    (m / sa.length + m / sb.length + (m - transpositions / 2) / m) / 3;

  // Winkler prefix bonus (up to 4 chars, p = 0.1).
  const prefixLen = (() => {
    const max = Math.min(4, sa.length, sb.length);
    let n = 0;
    for (let i = 0; i < max; i++) {
      if (sa[i] === sb[i]) n++;
      else break;
    }
    return n;
  })();

  return jaro + prefixLen * 0.1 * (1 - jaro);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\[\](){}.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type Match = {
  caseId: number;
  title: string;
  score: number;
};

/** Return top-3 matches above threshold for a draft title. */
export function findSimilarCases(
  draftTitle: string,
  existing: { id: number; title: string }[],
  threshold = 0.85,
  topN = 3,
): Match[] {
  return existing
    .map((c) => ({ caseId: c.id, title: c.title, score: jaroWinkler(draftTitle, c.title) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
