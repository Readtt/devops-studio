// Turn selected ADO bugs into context blocks for the shared AI injection
// mechanism (see ai/lib/contextBlocks). A bug's repro steps live as HTML in
// ADO with embedded `file:line` code references; stripping the markup to text
// preserves those references as readable lines the model can cite back.

import { getBug, type Bug } from "@/modules/ado";
import type { ContextBlock } from "@/modules/ai/lib/contextBlocks";

/** Hard ceiling on the HTML we'll even attempt to strip. Well past any real
 *  work item; it exists so a pasted 600 KB Word document can't hang the UI
 *  thread on the tag scan. */
const MAX_HTML_CHARS = 200_000;

/** Per-field cap for work-item prose that goes into a prompt. Mirrors
 *  `requirementBlock`'s clamp so an `#`-mentioned story and a requirement-bound
 *  suite can't spend wildly different budgets on the same text. */
const MAX_FIELD_CHARS = 4000;

function safeCodePoint(n: number): string {
  // Lone surrogates and out-of-range values throw in String.fromCodePoint;
  // a malformed entity shouldn't take down the whole context build.
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  if (n >= 0xd800 && n <= 0xdfff) return "";
  // C0 controls: a decoded NUL or BEL is a hazard downstream (JSON
  // serialization, SQLite TEXT) and never meaningful in requirement prose.
  // Tab / newline / carriage return are the exceptions worth keeping.
  if (n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d) return "";
  if (n === 0x7f) return "";
  return String.fromCodePoint(n);
}

/** Clamp one prompt-facing field, marking what was dropped. Unattributed
 *  truncation reads to the model as a complete list. */
export function clampField(text: string, label: string, max = MAX_FIELD_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated — showing ${max} of ${text.length} characters of ${label})`;
}

/** Minimal HTML → text for repro-step bodies. Block-level tags become line
 *  breaks; the rest is dropped and the handful of entities ADO emits are
 *  decoded. Good enough for prompt context — not a general HTML parser. */
export function stripHtml(html: string): string {
  return (
    html
      // The tag regexes below are O(n²) on pathological input (600 KB of "<a "
      // measured at ~38 s on the UI thread). Nothing legitimate in a work item
      // is anywhere near this, and every caller clamps further downstream.
      .slice(0, MAX_HTML_CHARS)
      // Inline `data:` URIs first. Pasting a screenshot from Word or Outlook
      // into ADO's rich editor embeds the whole image as base64 — routinely
      // tens of thousands of characters in a single attribute. That blows past
      // any sane per-tag bound below, so the tag would survive the strip and
      // bill the user for a base64 blob read as requirement prose.
      .replace(/\b(src|href)\s*=\s*"data:[^"]*"/gi, '$1=""')
      .replace(/\b(src|href)\s*=\s*'data:[^']*'/gi, "$1=''")
      // Bodies first, while the tags that delimit them still exist. Dropping
      // only the tags would leave the script/CSS source sitting in the prompt
      // as if it were requirement text.
      .replace(/<\s*(script|style)\b[^>]{0,2000}>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    // Cells before rows: ADO's rich editor emits tables for acceptance-criteria
    // grids, and without a cell separator every cell in a row ran together.
    .replace(/<\/\s*(td|th)\s*>/gi, " | ")
      .replace(/<\/\s*(p|ul|ol|div|h[1-6]|tr)\s*>/gi, "\n")
      // The OPENING <li> owns the line break, not the closing one: ADO's
      // editor routinely omits </li>, which used to run consecutive bullets
      // together on one line. `</li>` is deliberately absent from the list
      // above so a well-formed list doesn't get double-spaced.
      .replace(/<\s*li\b[^>]{0,1000}>/gi, "\n- ")
      .replace(/<\/\s*li\s*>/gi, "")
      // Requires a tag-like shape. `<[^>]+>` also matched a bare "<" and ate
      // everything up to the next ">", so an acceptance criterion reading
      // "qty < 10 and total > 5" silently became "qty  5" and the model tested
      // something the requirement never said.
      // Bounded rather than `*`: on input with many unclosed "<", an unbounded
      // scan restarts from every "<" and runs to end-of-string — measured at
      // 4.3s for 200 KB. The bound is what keeps that at ~100ms, so it can't be
      // raised to cover long tags; the `data:` strip above removes the only
      // attribute that legitimately gets that big. Measured real tags: a
      // Word-pasted <span style="…mso-*…"> is ~310 chars, an Excel <td> ~283.
      .replace(/<\/?[a-zA-Z][^>]{0,2000}>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
        safeCodePoint(parseInt(h, 16)),
      )
      // &amp; last, so "&amp;lt;" decodes to the literal "&lt;" rather than
      // being double-decoded into "<".
      .replace(/&amp;/g, "&")
      .split("\n")
      // Drop the dangling separator the last cell of each row leaves behind,
      // and the leading one a cell whose content ended in a block tag pushes
      // onto the next line (`<td><p>a</p></td>` — the `</p>` breaks the line
      // before `</td>` emits the pipe). Both read as a phantom empty cell.
      .map((l) =>
        l
          .trim()
          .replace(/\s*\|$/, "")
          .replace(/^\|\s*/, "")
          .trim(),
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** One context block for a fully-loaded work item (any type — labelled by its
 *  work-item type; severity only shows for Bugs). */
export function bugToContextBlock(bug: Bug): ContextBlock {
  const type = (bug.workItemType || "Work item").toUpperCase();
  const sev = bug.severity ? `, ${bug.severity}` : "";
  const heading = `${type} #${bug.id} (${bug.state || "Unknown state"}${sev})`;
  const lines: string[] = [`Title: ${bug.title}`];
  const repro = stripHtml(bug.reproStepsHtml);
  if (repro) {
    // Clamped like the other two: this is the LARGEST field on a Bug, so
    // exempting it defeated the whole point of capping the others.
    lines.push("", "Repro / details:", clampField(repro, "the repro steps"));
  }
  // Requirement types (User Story / PBI / Requirement / Issue) leave
  // ReproSteps empty and put their spec here — without these, attaching a user
  // story contributed nothing but a title.
  // `?? ""` because these fields post-date the type: a Bug built by hand or
  // restored from an older payload can be missing them entirely.
  // Clamped for the same reason `renderRequirementBlock` clamps: a team that
  // writes essays in acceptance criteria shouldn't crowd out the spec and the
  // code context just by being `#`-mentioned.
  const description = stripHtml(bug.descriptionHtml ?? "");
  if (description) {
    lines.push("", "Description:", clampField(description, "the description"));
  }
  const criteria = stripHtml(bug.acceptanceCriteriaHtml ?? "");
  if (criteria) {
    lines.push(
      "",
      "Acceptance criteria:",
      clampField(criteria, "the acceptance criteria"),
    );
  }
  return { heading, body: lines.join("\n") };
}

/** Fetch the selected bugs and turn each into a context block. Best-effort —
 *  a bug that fails to load (deleted, permissions) is skipped rather than
 *  failing the whole run. */
export async function bugsToContextBlocks(
  bugIds: number[],
): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];
  for (const id of bugIds) {
    try {
      blocks.push(bugToContextBlock(await getBug(id)));
    } catch {
      // Skip unreadable bug.
    }
  }
  return blocks;
}
