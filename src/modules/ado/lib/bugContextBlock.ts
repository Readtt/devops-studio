// Turn selected ADO bugs into context blocks for the shared AI injection
// mechanism (see ai/lib/contextBlocks). A bug's repro steps live as HTML in
// ADO with embedded `file:line` code references; stripping the markup to text
// preserves those references as readable lines the model can cite back.

import { getBug, type Bug } from "@/modules/ado";
import type { ContextBlock } from "@/modules/ai/lib/contextBlocks";

/** Minimal HTML → text for repro-step bodies. Block-level tags become line
 *  breaks; the rest is dropped and the handful of entities ADO emits are
 *  decoded. Good enough for prompt context — not a general HTML parser. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|li|ul|ol|div|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One context block for a fully-loaded bug. */
export function bugToContextBlock(bug: Bug): ContextBlock {
  const sev = bug.severity ? `, ${bug.severity}` : "";
  const heading = `BUG #${bug.id} (${bug.state || "Unknown state"}${sev})`;
  const lines: string[] = [`Title: ${bug.title}`];
  const repro = stripHtml(bug.reproStepsHtml);
  if (repro) {
    lines.push("", "Repro / details:", repro);
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
