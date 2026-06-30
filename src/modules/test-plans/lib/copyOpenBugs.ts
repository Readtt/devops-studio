import { listSuiteBugs, type SuiteBug } from "@/modules/ado";
import { useActionToast } from "@/components/actionToastStore";
import { copyItems } from "@/components/copyableItems";

/**
 * "Open" = the bug's ADO workflow state category is neither Completed nor
 * Removed. Resolved counts as open: a QA tester still owns a resolved bug until
 * they re-test and close it, and ADO itself keeps Resolved items on the
 * backlog. An empty category (couldn't resolve) is treated as open — the safe
 * default for a "what's outstanding" copy.
 */
function isOpenBug(b: SuiteBug): boolean {
  return b.stateCategory !== "Completed" && b.stateCategory !== "Removed";
}

/**
 * Fetch a suite's bugs, keep the open ones, and copy them to the clipboard in
 * the exact same format the History pane's Bugs section uses (via the shared
 * {@link copyItems}): plain `Bug <id>: <title>` rows plus an HTML payload that
 * hyperlinks each id to the work item. Drives the ActionToast for progress +
 * result because the fetch is a network round-trip that can be slow, empty, or
 * fail.
 */
export async function copyOpenBugsForSuite(
  planId: number,
  suiteId: number,
): Promise<void> {
  const { show, update } = useActionToast.getState();
  const id = show({ message: "Copying open bugs…", busy: true });
  try {
    const open = (await listSuiteBugs(planId, suiteId)).filter(isOpenBug);
    if (open.length === 0) {
      update(id, {
        tone: "info",
        message: "No open bugs in this suite.",
        busy: false,
      });
      return;
    }
    await copyItems(
      "Bug",
      open.map((b) => ({ id: b.id, title: b.title, webUrl: b.webUrl })),
    );
    update(id, {
      tone: "ok",
      message: `Copied ${open.length} open bug${open.length === 1 ? "" : "s"}.`,
      busy: false,
    });
  } catch (e) {
    update(id, {
      tone: "error",
      message: `Couldn't copy bugs: ${e instanceof Error ? e.message : String(e)}`,
      busy: false,
    });
  }
}
