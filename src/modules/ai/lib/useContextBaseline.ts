// The "invisible" context every AI run carries regardless of what the user
// typed: their Settings → custom instructions and best-practices files, both
// injected into every surface's prompt (see bestPractices.ts / buildStableSystem).
//
// A meter that only counted the visible textarea would under-report exactly the
// case that bites — a modest spec sent alongside a 40k-token standards file. So
// every input surface folds this baseline into its estimate, and Settings shows
// it on its own so a bloated standards file is obvious and trimmable.
//
// File sizes come from fs_stat (bytes, no content read) and are cached at module
// scope so switching between panes/surfaces doesn't re-stat the same paths.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  TOKENS_PER_IMAGE,
  estimateTokens,
  estimateTokensFromBytes,
  type ContextSegment,
} from "./contextEstimate";

/** Mirror of the Rust `fs_stat` FileStat. */
type FileStat = { size: number; mtime: number; kind: string };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function isImagePath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  return m ? IMAGE_EXTS.has(m[1].toLowerCase()) : false;
}

// path → byte size. Module-scoped: best-practices paths rarely change, and the
// baseline is read on every input surface, so a shared cache avoids a flurry of
// duplicate fs_stat calls as the user moves between panes.
const sizeCache = new Map<string, number>();

export type ContextBaseline = {
  /** Non-zero contributors, ready to spread into a surface's segment list. */
  segments: ContextSegment[];
  /** Total baseline tokens (custom instructions + enabled best-practices). */
  tokens: number;
};

/** Estimate the always-injected context footprint from the user's Settings. */
export function useContextBaseline(): ContextBaseline {
  const customInstructions = usePreferencesStore((s) => s.customInstructions);
  const files = usePreferencesStore((s) => s.bestPracticeFiles);

  const enabled = files.filter((f) => f.enabled && f.path.trim().length > 0);
  const textPaths = enabled.filter((f) => !isImagePath(f.path)).map((f) => f.path);
  const pathsKey = textPaths.join("|");

  // Re-stat whenever the SET of enabled text paths changes. Bump a version so a
  // resolved size triggers a re-render even though the mutation lands in the
  // module-level cache rather than component state.
  const [, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    const missing = textPaths.filter((p) => !sizeCache.has(p));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map((path) =>
        invoke<FileStat>("fs_stat", { path })
          .then((stat) => sizeCache.set(path, stat.size))
          // Unreadable (offline share, moved) → treat as 0; it's skipped at run
          // time anyway. Cache the 0 so we don't re-stat a dead path every render.
          .catch(() => sizeCache.set(path, 0)),
      ),
    ).then(() => {
      if (alive) setVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  const customTokens = estimateTokens(customInstructions);

  let fileTokens = 0;
  for (const f of enabled) {
    if (isImagePath(f.path)) fileTokens += TOKENS_PER_IMAGE;
    else fileTokens += estimateTokensFromBytes(sizeCache.get(f.path) ?? 0);
  }

  const segments: ContextSegment[] = [];
  if (customTokens > 0)
    segments.push({ label: "Custom instructions", tokens: customTokens });
  if (fileTokens > 0)
    segments.push({
      label: `Best practices (${enabled.length} file${enabled.length === 1 ? "" : "s"})`,
      tokens: fileTokens,
    });

  return {
    segments,
    tokens: customTokens + fileTokens,
  };
}
