import { describe, expect, it } from "vitest";

import { isRepoInScope, scopedRepos, toggleRepoScope } from "./repoScope";
import type { WorkspaceRepo } from "@/modules/settings/store";

function repo(name: string): WorkspaceRepo {
  return { id: `id-${name}`, name, root: `C:\\src\\${name}`, ado: null };
}

const ONE = repo("repo-one");
const TWO = repo("repo-two");
const THREE = repo("repo-three");
const MANY = [ONE, TWO, THREE];

describe("scopedRepos", () => {
  it("passes every repo through when the scope is null", () => {
    expect(scopedRepos(MANY, null)).toEqual(MANY);
  });

  it("keeps only the scoped repos, in registry order", () => {
    expect(scopedRepos(MANY, [THREE.id, ONE.id])).toEqual([ONE, THREE]);
  });

  it("reads an empty scope as no repos, not as all of them", () => {
    // Deselecting every chip is a real state — it makes the run tool-less,
    // which is the per-run equivalent of turning code search off.
    expect(scopedRepos(MANY, [])).toEqual([]);
  });

  it("drops ids that no longer name a configured repo", () => {
    // A repo removed in Settings mid-draft must not resurrect itself, and must
    // not take the rest of the scope down with it.
    expect(scopedRepos(MANY, [TWO.id, "id-deleted"])).toEqual([TWO]);
  });
});

describe("isRepoInScope", () => {
  it("treats a null scope as everything selected", () => {
    expect(isRepoInScope(null, ONE.id)).toBe(true);
  });

  it("answers membership for an explicit scope", () => {
    expect(isRepoInScope([ONE.id], ONE.id)).toBe(true);
    expect(isRepoInScope([ONE.id], TWO.id)).toBe(false);
  });
});

describe("toggleRepoScope", () => {
  it("turns a null scope into everything-but-the-one clicked", () => {
    expect(toggleRepoScope(null, MANY, TWO.id)).toEqual([ONE.id, THREE.id]);
  });

  it("collapses back to null when the last excluded repo is re-added", () => {
    // "All on" must have ONE representation: a scope frozen at today's ids
    // would silently exclude a repo the user adds tomorrow.
    expect(toggleRepoScope([ONE.id, THREE.id], MANY, TWO.id)).toBeNull();
  });

  it("can empty the scope out entirely", () => {
    expect(toggleRepoScope([ONE.id], MANY, ONE.id)).toEqual([]);
  });

  it("forgets ids for repos that left the registry", () => {
    expect(toggleRepoScope([ONE.id, "id-deleted"], MANY, THREE.id)).toEqual([
      ONE.id,
      THREE.id,
    ]);
  });

  it("re-adding the last missing repo of a stale scope still collapses", () => {
    expect(toggleRepoScope([ONE.id, "id-deleted", THREE.id], MANY, TWO.id))
      .toBeNull();
  });

  it("ignores a repo that is no longer configured", () => {
    // A chip rendered from a snapshot the registry has moved past. Adding the
    // dead id would push the count to `ids.length` and collapse the scope to
    // null — silently re-including every repo the user deselected.
    expect(toggleRepoScope([ONE.id], [ONE, TWO], "id-deleted")).toEqual([
      ONE.id,
    ]);
    expect(toggleRepoScope(null, [ONE, TWO], "id-deleted")).toBeNull();
  });
});
