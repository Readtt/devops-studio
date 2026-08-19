// Tab titles for the code viewer.
//
// A viewer tab is titled by its bare basename. That's ambiguous only when two
// open tabs are the same filename from different repos — which is rare enough
// that permanently prefixing every title would cost tab-strip width all the
// time to disambiguate almost never. So the prefix appears exactly when it
// resolves something, and it appears on BOTH sides: one prefixed tab beside an
// unprefixed one reads as an odd one out rather than as a pair.

import type { CodeViewerTab } from "./store/types";

export type ViewerTitlePlan = {
  /** Title for the tab about to open. */
  title: string;
  /** Already-open tabs to rename, so the collision is legible from both. */
  retitle: { id: number; title: string }[];
};

export function basenameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function planViewerTitle(
  input: {
    path: string;
    repoName: string | null;
    startLine?: number;
    endLine?: number;
  },
  open: CodeViewerTab[],
): ViewerTitlePlan {
  const base = basenameOf(input.path);
  const suffix = input.startLine
    ? `:${input.startLine}${
        input.endLine && input.endLine !== input.startLine
          ? `–${input.endLine}`
          : ""
      }`
    : "";
  const collisions = open.filter(
    (t) =>
      t.path !== input.path &&
      basenameOf(t.path) === base &&
      (t.repoName ?? null) !== input.repoName,
  );
  if (!input.repoName || collisions.length === 0) {
    return { title: `${base}${suffix}`, retitle: [] };
  }
  return {
    title: `${input.repoName}/${base}${suffix}`,
    retitle: collisions
      .filter((t) => t.repoName && !t.title.startsWith(`${t.repoName}/`))
      .map((t) => ({ id: t.id, title: `${t.repoName}/${t.title}` })),
  };
}
