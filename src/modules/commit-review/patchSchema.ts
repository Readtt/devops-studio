import { z } from "zod";

/** The shape of a suggested-fix patch a finding can carry. Validated before an
 *  ApplyPatchCard is mounted, so a malformed patch shows a plain warning instead
 *  of a half-broken apply card.
 *
 *  endLine isn't `.positive()` on purpose: an insert (no removal) is expressed
 *  as endLine = startLine - 1, so endLine 0 is legal for a startLine-1 insert. */
export const PatchSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int(),
  replacement: z.string(),
});

export type PatchBody = z.infer<typeof PatchSchema>;

/** Persisted record of an applied patch. `beforeText` snapshots the file lines
 *  as they were before the patch so the before/after diff still renders after a
 *  reload — by then the file on disk already holds the replacement, so a live
 *  re-read would show an empty diff. */
export type AppliedPatchRecord = {
  appliedAt: string;
  path: string;
  startLine: number;
  endLine: number;
  beforeText: string;
};

/** Map of finding id → applied record. Persisted with the run so the "Applied"
 *  state + before/after diff survive a reload. */
export type AppliedPatchesMap = Record<string, AppliedPatchRecord>;

/** Parse + validate a patch block body. Returns a discriminated result so both
 *  the render guard and the apply card share one definition of "valid patch". */
export function parsePatch(
  body: string,
): { ok: true; value: PatchBody } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
  const r = PatchSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.join(".");
    return {
      ok: false,
      error: where ? `${where}: ${issue?.message}` : (issue?.message ?? "invalid patch"),
    };
  }
  return { ok: true, value: r.data };
}
