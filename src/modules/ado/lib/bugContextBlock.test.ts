import { describe, expect, it } from "vitest";
import type { Bug } from "../types";
import { bugToContextBlock, stripHtml } from "./bugContextBlock";

function workItem(over: Partial<Bug> = {}): Bug {
  return {
    id: 4821,
    title: "Bulk-archive contacts",
    state: "Active",
    workItemType: "User Story",
    reproStepsHtml: "",
    descriptionHtml: "",
    acceptanceCriteriaHtml: "",
    tags: [],
    url: "https://dev.azure.com/org/_apis/wit/workItems/4821",
    ...over,
  } as Bug;
}

describe("stripHtml", () => {
  it("separates table cells instead of running them together", () => {
    // ADO's rich editor emits tables for acceptance-criteria grids. Without a
    // cell separator every cell in a row concatenated into one unreadable run.
    const html =
      "<table><tr><td>Given</td><td>When</td><td>Then</td></tr>" +
      "<tr><td>logged in</td><td>clicks archive</td><td>row hides</td></tr></table>";
    const out = stripHtml(html);
    expect(out).toContain("Given | When | Then");
    expect(out).toContain("logged in | clicks archive | row hides");
    // Rows still break onto their own lines.
    expect(out.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("leaves no dangling separator at the end of a row", () => {
    expect(stripHtml("<tr><td>a</td><td>b</td></tr>")).toBe("a | b");
  });

  it("still handles the block tags it always did", () => {
    expect(stripHtml("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(stripHtml("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(stripHtml("x<br/>y")).toBe("x\ny");
    expect(stripHtml("&lt;tag&gt; &amp; more")).toBe("<tag> & more");
  });

  it("keeps a bare '<' from eating the rest of the sentence", () => {
    // `<[^>]+>` matched from a literal "<" all the way to the next ">", so an
    // acceptance criterion stating a range silently lost its middle and the
    // model wrote cases for a requirement nobody had written.
    expect(stripHtml("qty < 10 and total > 5")).toBe("qty < 10 and total > 5");
    expect(stripHtml("<p>fails when qty < 3</p>")).toBe("fails when qty < 3");
  });

  it("drops script and style BODIES, not just their tags", () => {
    // Stripping only the tags left the source sitting in the prompt as if it
    // were requirement prose.
    expect(stripHtml("<script>alert('pwn')</script><p>real</p>")).toBe("real");
    expect(stripHtml("<style>.a{color:red}</style><p>real</p>")).toBe("real");
  });

  it("separates list items when ADO omits the closing tag", () => {
    // ADO's editor emits unclosed <li> routinely; these used to collapse into
    // one line, turning two acceptance criteria into one.
    expect(stripHtml("<ul><li>a<li>b</ul>")).toBe("- a\n- b");
  });

  it("decodes numeric entities Word and Outlook paste in", () => {
    expect(stripHtml("Don&#39;t &#8212; do it")).toBe("Don't — do it");
    expect(stripHtml("&#x2014; dash")).toBe("— dash");
    // A malformed entity must not throw and take the whole context build down.
    expect(() => stripHtml("&#999999999; &#xD800;")).not.toThrow();
  });

  it("decodes &amp; last so a double-escaped entity stays literal", () => {
    expect(stripHtml("&amp;lt;")).toBe("&lt;");
  });

  it("caps pathological input instead of hanging the UI thread", () => {
    // The tag scan is O(n²); 600 KB of this measured ~38s before the cap.
    const start = Date.now();
    stripHtml("<a ".repeat(200_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("bugToContextBlock", () => {
  it("includes a user story's description and acceptance criteria", () => {
    // The regression that matters: requirement types leave ReproSteps empty, so
    // reading only that field made an attached story contribute a title alone.
    const block = bugToContextBlock(
      workItem({
        descriptionHtml: "<p>Users need to archive many contacts at once.</p>",
        acceptanceCriteriaHtml: "<ul><li>Select all works</li><li>Undo works</li></ul>",
      }),
    );
    expect(block.heading).toContain("USER STORY #4821");
    expect(block.body).toContain("Description:");
    expect(block.body).toContain("Users need to archive many contacts at once.");
    expect(block.body).toContain("Acceptance criteria:");
    expect(block.body).toContain("- Select all works");
  });

  it("omits the new sections when the fields are empty", () => {
    const block = bugToContextBlock(
      workItem({ workItemType: "Bug", reproStepsHtml: "<p>Steps here</p>" }),
    );
    expect(block.body).toContain("Repro / details:");
    expect(block.body).not.toContain("Description:");
    expect(block.body).not.toContain("Acceptance criteria:");
  });

  it("tolerates a payload from before the fields existed", () => {
    // Old checkpoints and any org whose response omits them must not crash.
    const legacy = { ...workItem() } as Record<string, unknown>;
    delete legacy.descriptionHtml;
    delete legacy.acceptanceCriteriaHtml;
    expect(() => bugToContextBlock(legacy as Bug)).not.toThrow();
  });
});
