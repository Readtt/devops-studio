import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./native", () => ({ listTeamMembers: vi.fn() }));

import { listTeamMembers } from "./native";
import {
  __resetTeamMembers,
  invalidateTeamMembers,
  loadTeamMembers,
  TEAM_MEMBERS_RETRY_MS,
} from "./useTeamMembers";
import type { TeamMember } from "./types";

const mockList = vi.mocked(listTeamMembers);

const ADA = { displayName: "Ada", uniqueName: "ada@x.com" } as TeamMember;
const GRACE = { displayName: "Grace", uniqueName: "grace@x.com" } as TeamMember;

const T0 = 1_700_000_000_000;

/**
 * `ado_list_team_members` enumerates every TEAM in the project and reads each
 * one's membership, so one call is dozens of ADO requests. Every assertion here
 * is about how many times that runs — the picker's contents are the easy half.
 */
describe("team-member cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTeamMembers();
  });

  it("serves N callers from one fetch", async () => {
    mockList.mockResolvedValue([ADA]);

    const all = await Promise.all([
      loadTeamMembers(T0),
      loadTeamMembers(T0),
      loadTeamMembers(T0),
    ]);

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(all.every((m) => m === all[0])).toBe(true);
  });

  it("serves later callers from the cache without refetching", async () => {
    mockList.mockResolvedValue([ADA]);
    await loadTeamMembers(T0);
    await loadTeamMembers(T0 + 5 * TEAM_MEMBERS_RETRY_MS);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  // The bug this exists for: a failure left the cache empty with nothing
  // recording that it had failed, so every remount of a pane holding a
  // developer picker re-ran the whole fan-out. Under a 429 — which is exactly
  // when panes are remounting because nothing loaded — that is a retry storm
  // that keeps the account rate-limited.
  it("does not refetch on every caller after a failure", async () => {
    mockList.mockRejectedValue(new Error("429"));

    await expect(loadTeamMembers(T0)).rejects.toThrow();
    await expect(loadTeamMembers(T0 + 1)).rejects.toThrow();
    await expect(loadTeamMembers(T0 + 500)).rejects.toThrow();
    await expect(
      loadTeamMembers(T0 + TEAM_MEMBERS_RETRY_MS - 1),
    ).rejects.toThrow();

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("retries once the backoff has elapsed", async () => {
    mockList.mockRejectedValueOnce(new Error("429")).mockResolvedValue([ADA]);

    await expect(loadTeamMembers(T0)).rejects.toThrow();
    const after = await loadTeamMembers(T0 + TEAM_MEMBERS_RETRY_MS);

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(after).toEqual([ADA]);
  });

  // The roster is per PROJECT. Without this, switching projects left the assign
  // pickers offering the previous project's people — names ADO will not accept
  // on the work items being created now.
  it("refetches after invalidation, and the backoff does not survive it", async () => {
    mockList.mockRejectedValueOnce(new Error("429")).mockResolvedValue([GRACE]);

    await expect(loadTeamMembers(T0)).rejects.toThrow();
    invalidateTeamMembers();
    await expect(loadTeamMembers(T0 + 1)).resolves.toEqual([GRACE]);

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("drops a cached roster on invalidation", async () => {
    mockList.mockResolvedValueOnce([ADA]).mockResolvedValue([GRACE]);

    await expect(loadTeamMembers(T0)).resolves.toEqual([ADA]);
    invalidateTeamMembers();
    await expect(loadTeamMembers(T0)).resolves.toEqual([GRACE]);
  });
});
