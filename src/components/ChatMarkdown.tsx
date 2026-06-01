import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CodeRefChip, parseCodeRef } from "@/components/CodeRefChip";
import { CODE_REF_PATTERN, isCodeRefToken } from "@/components/codeRef";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  CodeIcon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ApplyEditCard, parseEdit } from "@/components/chat/ApplyEditCard";
import { BulkApplyEditCard } from "@/components/chat/BulkApplyEditCard";
import { ApplyPatchCard } from "@/modules/code-review/ApplyPatchCard";
import { parsePatch } from "@/modules/code-review/patchSchema";
import { ChatCodeMirror } from "@/modules/code-viewer/ChatCodeMirror";

/**
 * Markdown renderer tuned for chat assistant messages. Built for streaming:
 * blocks are memoized by stable identity so a partial response only re-renders
 * the last block as tokens arrive. Production-grade enough for day-to-day QA
 * work — paragraphs, lists, code, blockquotes, headings, links — without
 * pulling in a full CommonMark parser.
 *
 * Special powers vs. a plain markdown renderer:
 *   1. Inline `#15310` references render as clickable chips that open the
 *      Test Case Pane (or jump to it if already open).
 *   2. `file:src/foo.ts#L42-58` link hrefs open the in-app CodeViewer.
 *   3. `case:15310` or `ado:15310` link hrefs open the Test Case Pane.
 *   4. `bug:1234` opens the Bug Pane.
 *   5. Fenced `devops-edit` blocks render as the diff-style ApplyEditCard.
 */

export type ApplyEditHandler = (payload: unknown) => Promise<ApplyEditResult>;

export type ApplyEditResult = {
  ok: boolean;
  message?: string;
  /** Optional pre-apply snapshot supplied by the handler. Used for bug edits,
   *  where the card can't read the bug's prior state locally (lookupCase only
   *  covers cases) — the handler captures it via getBug before patching. When
   *  set, it overrides the snapshot the card would build from `lookupCase`. */
  before?: EditBeforeSnapshot;
};

export type CaseLookup = (caseId: number) =>
  | {
      title: string;
      steps: { index: number; action: string; expected: string }[];
      webUrl: string | null;
      /** Plan + suite the case is being viewed in, when the caller knows it
       *  (e.g. suite chat). Forwarded on the open-test-case event so the
       *  opened tab's Execute control targets the right test point instead
       *  of falling back to a suite picker. */
      suite?: { planId: number; suiteId: number } | null;
    }
  | null;

/** Plain-text snapshot of a bug's current scalar fields. Bugs aren't in the
 *  local case cache, so the card fetches this on demand (via `fetchBug`) to
 *  render a real before/after diff for update-bug / delete-bug. */
export type BugSnapshot = {
  id: number;
  title: string;
  state: string | null;
  severity: string | null;
  /** Repro steps as plain text (ADO stores HTML — caller strips it). */
  reproText: string | null;
};

/** Resolver the parent provides so bug-edit cards can read a bug's prior state
 *  to diff against. Async because the bug body lives in ADO, not in memory.
 *  Returns null when the bug can't be read (deleted / permissions). */
export type BugLookup = (bugId: number) => Promise<BugSnapshot | null>;

/** Snapshot of a case's state before an edit was applied. Stored in the
 *  applied-edits map so the Undo button can revive the exact prior state
 *  even if the case has been further modified since. */
export type EditBeforeSnapshot =
  | { kind: "rename"; title: string }
  | {
      kind: "rewrite-steps";
      steps: { action: string; expected: string }[];
    }
  /** Prior scalar fields of a bug, captured before an update-bug patch so the
   *  edit can be reverted. (reproSteps isn't snapshotted — its HTML doesn't
   *  round-trip cleanly through the plain-text update path.) */
  | {
      kind: "update-bug";
      bugId: number;
      title?: string;
      severity?: string;
      state?: string;
    }
  /** Records the id of a bug created by a create-bug edit so undo can delete
   *  it (soft-delete to the Recycle Bin). */
  | { kind: "create-bug"; bugId: number };

export type AppliedEditRecord = {
  appliedAt: string;
  message: string;
  caseId?: number;
  before?: EditBeforeSnapshot;
};

/** Map of devops-edit block content hash → applied record. Empty when no
 *  block in this message has been applied yet. Used by ApplyEditCard to
 *  decide whether to show the "Apply" button or the quiet "Applied" state. */
export type AppliedEditsMap = Record<string, AppliedEditRecord>;

/** Persisted record of an applied code-review-patch, keyed (like edits) by a
 *  content hash of the block. `beforeText` snapshots the file lines as they
 *  were before the patch so the before/after diff still renders after a
 *  reload — by then the file on disk already contains the replacement, so a
 *  live re-read would show an empty diff. */
export type AppliedPatchRecord = {
  appliedAt: string;
  path: string;
  startLine: number;
  endLine: number;
  beforeText: string;
};

export type AppliedPatchesMap = Record<string, AppliedPatchRecord>;

/** Handler the parent provides to undo an applied edit. Receives the
 *  persisted applied record (which carries the caseId + before snapshot)
 *  and performs the inverse ADO write. */
export type UndoEditHandler = (
  record: AppliedEditRecord,
) => Promise<ApplyEditResult>;

export type ChatMarkdownProps = {
  source: string;
  className?: string;
  onApplyEdit?: ApplyEditHandler;
  /** When provided, ApplyEditCard renders a real before/after diff and
   *  inline `#15310` chips can show the case title in their tooltip. */
  lookupCase?: CaseLookup;
  /** When provided, bug-edit cards (create/update/delete-bug) render a diff:
   *  the proposed change diffed against the bug's current state fetched here. */
  fetchBug?: BugLookup;
  /** Tells the last block of a streaming message to render a soft caret —
   *  the caret is owned here (not by the parent) so it stays glued to the
   *  end of the actual text instead of dangling below it. */
  streaming?: boolean;
  /** Already-applied edit hashes for this specific message. Block contents
   *  are hashed via `hashEditBody`. */
  appliedEdits?: AppliedEditsMap;
  /** Called after a successful apply so the parent can persist the
   *  applied state and skip showing the Apply button on rerender. */
  onEditApplied?: (blockHash: string, result: AppliedEditRecord) => void;
  /** Performs the inverse ADO write to revert an applied edit. */
  onUndoEdit?: UndoEditHandler;
  /** Called after a successful undo so the parent can drop the persisted
   *  applied-edit record. */
  onEditUndone?: (blockHash: string) => void;
  /** Already-applied code-review patches for this message, keyed by block
   *  hash. When set for a block, its ApplyPatchCard renders the persisted
   *  "Applied" state + before/after diff instead of a live "Apply" button. */
  appliedPatches?: AppliedPatchesMap;
  /** Called after a patch is applied so the parent can persist it onto the
   *  message (survives reload). */
  onPatchApplied?: (blockHash: string, record: AppliedPatchRecord) => void;
};

export function ChatMarkdown({
  source,
  className,
  onApplyEdit,
  lookupCase,
  fetchBug,
  streaming,
  appliedEdits,
  onEditApplied,
  onUndoEdit,
  onEditUndone,
  appliedPatches,
  onPatchApplied,
}: ChatMarkdownProps) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <div
      className={cn(
        // Vertical rhythm: paragraphs and lists breathe at the same gap so
        // streaming inserts feel continuous instead of jumping the page.
        "flex flex-col gap-2.5 text-[12px] leading-[1.65]",
        className,
      )}
    >
      {blocks.map((b, i) => (
        <BlockRenderer
          key={b.key}
          block={b}
          onApplyEdit={onApplyEdit}
          lookupCase={lookupCase}
          fetchBug={fetchBug}
          streamingTail={streaming && i === blocks.length - 1}
          appliedEdits={appliedEdits}
          onEditApplied={onEditApplied}
          onUndoEdit={onUndoEdit}
          onEditUndone={onEditUndone}
          appliedPatches={appliedPatches}
          onPatchApplied={onPatchApplied}
        />
      ))}
    </div>
  );
}

// --- Block grammar ----------------------------------------------------------

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; key: string }
  | { kind: "paragraph"; text: string; key: string }
  | { kind: "bullets"; items: string[]; key: string }
  | { kind: "numbered"; items: string[]; key: string }
  | { kind: "quote"; text: string; key: string }
  | { kind: "code"; lang: string | null; body: string; key: string }
  | { kind: "hr"; key: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  // Counter feeds the block's stable key so memo can skip unchanged blocks
  // during streaming. We hash by `${kind}-${index}-${content-prefix}` so an
  // append at the tail of the last paragraph doesn't break the key of any
  // earlier block.
  let blockIdx = 0;
  const mkKey = (kind: string, payload: string): string =>
    `${blockIdx++}-${kind}-${payload.length}-${cheapHash(payload)}`;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w[\w-]*)?\s*$/);
    if (fence) {
      const lang = fence[1] ?? null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      const joined = body.join("\n");
      out.push({ kind: "code", lang, body: joined, key: mkKey(`code-${lang ?? ""}`, joined) });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push({ kind: "hr", key: mkKey("hr", "") });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      const text = heading[2];
      out.push({ kind: "heading", level, text, key: mkKey(`h${level}`, text) });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "bullets", items, key: mkKey("ul", items.join("\n")) });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "numbered", items, key: mkKey("ol", items.join("\n")) });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const text = quoted.join(" ");
      out.push({ kind: "quote", text, key: mkKey("q", text) });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const text = para.join(" ");
    out.push({ kind: "paragraph", text, key: mkKey("p", text) });
  }
  return out;
}

// Tiny non-crypto hash (djb2-ish). Two uses:
//   - Stable React keys for parsed blocks (uniqueness only needs to hold
//     within the parent, and blockIdx prefix already guarantees that).
//   - Persisted identity for devops-edit blocks so we can mark them as
//     applied. The full body string is hashed by `hashEditBody` below.
export function hashEditBody(s: string): string {
  return cheapHash(s.replace(/\s+/g, ""));
}

function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// --- Block renderer ---------------------------------------------------------

type BlockRendererProps = {
  block: Block;
  onApplyEdit?: ApplyEditHandler;
  lookupCase?: CaseLookup;
  fetchBug?: BugLookup;
  streamingTail?: boolean;
  appliedEdits?: AppliedEditsMap;
  onEditApplied?: (blockHash: string, result: AppliedEditRecord) => void;
  onUndoEdit?: UndoEditHandler;
  onEditUndone?: (blockHash: string) => void;
  appliedPatches?: AppliedPatchesMap;
  onPatchApplied?: (blockHash: string, record: AppliedPatchRecord) => void;
};

const blockRendererEqual = (a: BlockRendererProps, b: BlockRendererProps) =>
  // block.key embeds a content hash — if the hash matches, the block hasn't
  // changed between renders. We still re-render when the streamingTail flag
  // flips (last block becomes a settled block once a newer block follows)
  // or when handlers actually change identity. The `parseBlocks` call
  // produces fresh block objects on every keystroke during streaming, so
  // the default shallow compare would re-render everything — this custom
  // equality is what keeps mid-thread blocks stable.
  a.block.key === b.block.key &&
  a.streamingTail === b.streamingTail &&
  a.onApplyEdit === b.onApplyEdit &&
  a.lookupCase === b.lookupCase &&
  a.fetchBug === b.fetchBug &&
  a.appliedEdits === b.appliedEdits &&
  a.onEditApplied === b.onEditApplied &&
  a.onUndoEdit === b.onUndoEdit &&
  a.onEditUndone === b.onEditUndone &&
  a.appliedPatches === b.appliedPatches &&
  a.onPatchApplied === b.onPatchApplied;

const BlockRenderer = memo(function BlockRenderer({
  block,
  onApplyEdit,
  lookupCase,
  fetchBug,
  streamingTail,
  appliedEdits,
  onEditApplied,
  onUndoEdit,
  onEditUndone,
  appliedPatches,
  onPatchApplied,
}: BlockRendererProps) {
  switch (block.kind) {
    case "heading": {
      // Heading sizes respect the project's 13px UI cap (see CLAUDE.md type
      // scale). H1 is capped at the section-heading size; H2/H3 step down
      // into emphasis/body so model-emitted headings never tower over the
      // surrounding chrome.
      const size =
        block.level === 1
          ? "text-[13px] font-semibold tracking-tight"
          : block.level === 2
            ? "text-[12.5px] font-semibold tracking-tight"
            : "text-[12px] font-semibold";
      return (
        <p className={cn(size, "leading-snug text-foreground")}>
          {renderInline(block.text, { lookupCase })}
          {streamingTail ? <Caret /> : null}
        </p>
      );
    }
    case "paragraph":
      return (
        <p className="text-[12px] leading-[1.65] text-foreground/92">
          {renderInline(block.text, { lookupCase })}
          {streamingTail ? <Caret /> : null}
        </p>
      );
    case "bullets":
      return (
        <ul className="ml-4 list-disc text-[12px] leading-[1.65] text-foreground/92 marker:text-muted-foreground/55">
          {block.items.map((t, i) => (
            <li key={i} className="pl-1">
              {renderInline(t, { lookupCase })}
              {streamingTail && i === block.items.length - 1 ? <Caret /> : null}
            </li>
          ))}
        </ul>
      );
    case "numbered":
      return (
        <ol className="ml-4 list-decimal text-[12px] leading-[1.65] text-foreground/92 marker:font-mono marker:text-[10.5px] marker:text-muted-foreground/55">
          {block.items.map((t, i) => (
            <li key={i} className="pl-1">
              {renderInline(t, { lookupCase })}
              {streamingTail && i === block.items.length - 1 ? <Caret /> : null}
            </li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <p className="border-l-2 border-primary/35 bg-primary/[0.04] py-1 pl-3 text-[11.5px] italic leading-relaxed text-muted-foreground">
          {renderInline(block.text, { lookupCase })}
        </p>
      );
    case "hr":
      return <hr className="my-1 border-border/40" />;
    case "code":
      // While an actionable block is still the streaming tail its JSON is
      // necessarily incomplete, so schema validation would fail and flash a
      // "skipped a malformed block" warning on every token until the closing
      // fence arrives. Show a calm "writing…" placeholder instead and only
      // validate once the block is complete (no longer the tail).
      if (
        streamingTail &&
        (block.lang === "devops-edit" ||
          block.lang === "devops-bulk-edit" ||
          block.lang === "code-review-patch")
      ) {
        return <PendingActionBlock lang={block.lang} />;
      }
      if (block.lang === "devops-edit" && onApplyEdit) {
        // Validate the edit shape up front so a malformed block reads as a
        // plain warning instead of an apply card the user can't action.
        // parseEdit is lenient (maps unrecognized kinds to "unknown") so we
        // also reject that here — an unknown kind has no apply path.
        const edit = parseEdit(block.body);
        if (!edit.ok) {
          return <EditWarning error={edit.error} />;
        }
        if (edit.kind === "unknown") {
          return <EditWarning error="unrecognized edit kind" />;
        }
        const blockHash = hashEditBody(block.body);
        const applied = appliedEdits?.[blockHash] ?? null;
        return (
          <ApplyEditCard
            body={block.body}
            onApply={onApplyEdit}
            lookupCase={lookupCase}
            fetchBug={fetchBug}
            applied={applied}
            onApplied={(result) => onEditApplied?.(blockHash, result)}
            onUndo={onUndoEdit}
            onUndone={() => onEditUndone?.(blockHash)}
          />
        );
      }
      if (block.lang === "devops-bulk-edit" && onApplyEdit) {
        const blockHash = hashEditBody(block.body);
        return (
          <BulkApplyEditCard
            body={block.body}
            blockHash={blockHash}
            onApply={onApplyEdit}
            lookupCase={lookupCase}
            fetchBug={fetchBug}
            appliedEdits={appliedEdits}
            onApplied={(subHash, record) => onEditApplied?.(subHash, record)}
          />
        );
      }
      if (block.lang === "code-review-patch") {
        // Validate the patch shape BEFORE mounting the apply card so a
        // malformed block reads as a plain warning, not a broken card.
        const patch = parsePatch(block.body);
        if (!patch.ok) {
          return <PatchWarning error={patch.error} />;
        }
        const blockHash = hashEditBody(block.body);
        return (
          <ApplyPatchCard
            body={block.body}
            applied={appliedPatches?.[blockHash] ?? null}
            onApplied={(record) => onPatchApplied?.(blockHash, record)}
          />
        );
      }
      return (
        <CodeBlock
          lang={block.lang}
          body={block.body}
          streaming={streamingTail}
        />
      );
  }
}, blockRendererEqual);

/** Shown while an actionable block (edit / bulk-edit / patch) is still
 *  streaming, so the user sees a card forming instead of a flickering
 *  "malformed" warning. Mirrors the three-dot streaming idiom used elsewhere. */
function PendingActionBlock({ lang }: { lang: string }) {
  const label =
    lang === "code-review-patch"
      ? "Preparing a patch"
      : lang === "devops-bulk-edit"
        ? "Preparing bulk edits"
        : "Preparing an edit";
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-border/55 bg-card/55 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-0.5" aria-hidden>
        <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-current" />
        <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-current [animation-delay:0.18s]" />
        <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-current [animation-delay:0.36s]" />
      </span>
      {label}…
    </div>
  );
}

/** Rendered in place of an apply card when a `code-review-patch` block fails
 *  schema validation — better than a half-broken card the user can't act on. */
function PatchWarning({ error }: { error: string }) {
  return (
    <div className="my-1 rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
      Skipped a malformed patch block ({error}). Ask the reviewer to re-emit it.
    </div>
  );
}

/** Same idea for a malformed `devops-edit` block — show the validation reason
 *  instead of mounting an apply card the user can't action. */
function EditWarning({ error }: { error: string }) {
  return (
    <div className="my-1 rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
      Skipped a malformed edit block ({error}). Ask the assistant to re-emit it.
    </div>
  );
}

function Caret() {
  // Subtle bar caret — locks to the end of the last block of a streaming
  // message. CSS-only blink keeps GPU work cheap during stream churn.
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[0.9em] w-[2px] translate-y-[2px] animate-[chat-caret_1s_steps(2,end)_infinite] bg-primary/85"
    />
  );
}

// --- Code block -------------------------------------------------------------

function CodeBlock({
  lang,
  body,
  streaming,
}: {
  lang: string | null;
  body: string;
  /** While the block is still streaming in we render a plain <pre> — mounting
   *  a CodeMirror per token would thrash. Once settled, swap to the themed,
   *  syntax-highlighted editor that matches Settings → General. */
  streaming?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // ignore
    }
  };
  return (
    <div className="group/code relative overflow-hidden rounded-md border border-border/55 bg-foreground/[0.035]">
      <div className="flex items-center justify-between border-b border-border/40 bg-foreground/[0.03] px-2.5 py-1">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <HugeiconsIcon icon={CodeIcon} size={10} strokeWidth={1.75} />
          <span className="font-mono uppercase tracking-wider">
            {lang ?? "code"}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCopy}
              aria-label="Copy code"
              className={cn(
                "inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[10px] transition-colors",
                copied
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                size={10}
                strokeWidth={1.75}
              />
              {copied ? "Copied" : "Copy"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-[11px]">
            {copied ? "Copied" : "Copy code"}
          </TooltipContent>
        </Tooltip>
      </div>
      {streaming ? (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-[1.55] text-foreground/90">
          <code>{body}</code>
        </pre>
      ) : (
        <ChatCodeMirror lang={lang} body={body} />
      )}
    </div>
  );
}

// --- Inline span renderer ---------------------------------------------------

type InlineCtx = {
  lookupCase?: CaseLookup;
};

function renderInline(input: string, ctx: InlineCtx): ReactNode {
  const nodes: ReactNode[] = [];
  let key = 0;
  let i = 0;
  while (i < input.length) {
    if (input[i] === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        const inner = input.slice(i + 1, end);
        const token = inner.trim();
        // Models routinely wrap a cited source in backticks (the prompts even
        // show the format that way), which used to render as dead monospace
        // instead of a clickable chip. Linkify a back-ticked file ref or
        // `#id` the same as a bare one so "give me the source" is openable.
        if (isCodeRefToken(token)) {
          const parsed = parseCodeRef(token);
          if (parsed) {
            nodes.push(
              <CodeRefChip key={key++} path={parsed.path} ranges={parsed.ranges} />,
            );
            i = end + 1;
            continue;
          }
        }
        const caseM = token.match(/^#(\d{3,7})$/);
        if (caseM) {
          nodes.push(
            <CaseChip
              key={key++}
              caseId={Number.parseInt(caseM[1], 10)}
              lookupCase={ctx.lookupCase}
            />,
          );
          i = end + 1;
          continue;
        }
        nodes.push(
          <code
            key={key++}
            className="rounded-sm bg-foreground/[0.08] px-1 py-px font-mono text-[10.5px] text-foreground/95"
          >
            {inner}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    if (input[i] === "[") {
      const close = findUnescaped(input, "]", i + 1);
      if (close !== -1 && input[close + 1] === "(") {
        const paren = findUnescaped(input, ")", close + 2);
        if (paren !== -1) {
          const text = input.slice(i + 1, close);
          const href = input.slice(close + 2, paren).trim();
          nodes.push(
            <SmartLink key={key++} href={href} label={text} />,
          );
          i = paren + 1;
          continue;
        }
      }
    }
    if (input[i] === "*" && input[i + 1] === "*") {
      const end = input.indexOf("**", i + 2);
      if (end > i) {
        nodes.push(
          <strong key={key++} className="font-semibold text-foreground">
            {renderInline(input.slice(i + 2, end), ctx)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }
    if (input[i] === "*") {
      const end = input.indexOf("*", i + 1);
      if (end > i) {
        nodes.push(
          <em key={key++} className="italic">
            {renderInline(input.slice(i + 1, end), ctx)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }
    const next = nextMarkupIndex(input, i + 1);
    const segment = input.slice(i, next);
    pushTextWithAutoLinks(nodes, segment, ctx, () => key++);
    i = next;
  }
  return nodes;
}

/** Walks plain text segments and replaces bare `#15310` and bare file paths
 *  (`src/foo.ts:42-58`) with clickable chips. Done as a final pass over each
 *  text run so it can't accidentally fire inside backticks or link labels. */
function pushTextWithAutoLinks(
  out: ReactNode[],
  text: string,
  ctx: InlineCtx,
  nextKey: () => number,
) {
  // Matches: #123  or  src/foo.ts:42  or  src/foo.ts:42-58
  // We require 3+ digits for `#` matches so fresh ADO projects (where IDs
  // are still 3 digits) work, while still avoiding noise from plain text
  // like "#1" or "#42" that would commonly be a chapter or footnote ref
  // rather than a work-item id. `\B` keeps us from matching inside words
  // (e.g. "color: #abc").
  // Group 3 captures the whole file ref INCLUDING a multi-range line spec
  // ("foo.cs:376,594-600,1080"); parseCodeRef splits it. The extension
  // allowlist lives in codeRef.ts (CODE_REF_PATTERN) so this scanner and the
  // inline-backtick linkifier stay in sync. A ref only matches as
  // `name.ext:line`, so a bare word like "config:" never matches.
  const re = new RegExp(`(\\B#(\\d{3,7})\\b)|(${CODE_REF_PATTERN})`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push(
        <Fragment key={nextKey()}>{text.slice(last, m.index)}</Fragment>,
      );
    }
    if (m[1] && m[2]) {
      const caseId = Number.parseInt(m[2], 10);
      out.push(
        <CaseChip key={nextKey()} caseId={caseId} lookupCase={ctx.lookupCase} />,
      );
    } else if (m[3]) {
      const parsed = parseCodeRef(m[3]);
      if (parsed) {
        out.push(
          <CodeRefChip
            key={nextKey()}
            path={parsed.path}
            ranges={parsed.ranges}
          />,
        );
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(<Fragment key={nextKey()}>{text.slice(last)}</Fragment>);
  }
}

function findUnescaped(s: string, needle: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === needle) return i;
  }
  return -1;
}

function nextMarkupIndex(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "`" || c === "[" || c === "*") return i;
  }
  return s.length;
}

// --- Inline chips (case / file / link) --------------------------------------

function CaseChip({
  caseId,
  lookupCase,
}: {
  caseId: number;
  lookupCase?: CaseLookup;
}) {
  const ref = lookupCase?.(caseId) ?? null;
  const title = ref?.title;
  const onOpenInApp = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-test-case", {
        detail: {
          caseId,
          title: title ? `#${caseId} ${title}` : `#${caseId}`,
          planId: ref?.suite?.planId ?? null,
          suiteId: ref?.suite?.suiteId ?? null,
        },
      }),
    );
  };
  const onOpenInAdo = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (ref?.webUrl) void openUrl(ref.webUrl);
  };
  // Chip itself is a stable pill — no hover-only icon swap that would
  // shift surrounding prose. Tooltip uses the `panel` variant so its
  // block layout can handle a wrapping title cleanly; the default `pill`
  // variant is inline-flex which jams the case-id badge next to wrapping
  // text and reads as a Z-shape.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenInApp}
          onAuxClick={ref?.webUrl ? onOpenInAdo : undefined}
          className="inline-flex max-w-[18rem] items-center gap-0.5 rounded-sm border border-primary/25 bg-primary/[0.08] px-1 py-px align-baseline font-mono text-[10.5px] font-medium text-primary transition-colors hover:border-primary/55 hover:bg-primary/[0.16]"
        >
          <span>#{caseId}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="max-w-[280px] p-0"
      >
        <div className="px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
            Case #{caseId}
          </div>
          <p className="mt-1 text-[12px] font-medium leading-snug text-foreground">
            {title ?? (
              <span className="italic text-muted-foreground">
                Not in current scope
              </span>
            )}
          </p>
        </div>
        <div className="border-t border-border/40 bg-foreground/[0.03] px-3 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
          {ref?.webUrl ? (
            <>
              Click to open in app
              <span className="mx-1 text-muted-foreground/55">·</span>
              middle-click for Azure DevOps
            </>
          ) : (
            "Click to open in app"
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function SmartLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  // Case scheme: `case:1234` or `ado:1234` — opens Test Case Pane.
  const caseMatch = /^(?:case|ado):(\d{1,8})$/i.exec(href);
  if (caseMatch) {
    const caseId = Number.parseInt(caseMatch[1], 10);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("devops-studio:open-test-case", {
              detail: { caseId, title: label || `#${caseId}` },
            }),
          );
        }}
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {label || `#${caseId}`}
      </button>
    );
  }
  // Bug scheme: `bug:1234` — opens Bug Pane.
  const bugMatch = /^bug:(\d{1,8})$/i.exec(href);
  if (bugMatch) {
    const bugId = Number.parseInt(bugMatch[1], 10);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("devops-studio:open-bug", {
              detail: { bugId, title: label || `Bug #${bugId}` },
            }),
          );
        }}
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {label || `Bug #${bugId}`}
      </button>
    );
  }
  // File scheme: `file:path#L42-L58` or `file:path:42-58[,…]` — opens the
  // viewer. Normalise the `#L` form to the `:` form so parseCodeRef handles
  // both (and multi-range).
  if (/^file:/i.test(href)) {
    const rest = href
      .slice(5)
      .replace(/#L/i, ":")
      .replace(/-L/gi, "-");
    const parsed = parseCodeRef(rest);
    if (parsed) {
      return <CodeRefChip path={parsed.path} ranges={parsed.ranges} />;
    }
  }
  // External URL — open in the user's browser via Tauri opener. Label is
  // rendered as a plain string (matching how case/bug/file chips treat
  // their label) so a model-emitted `[[foo](bar)](https://…)` doesn't
  // recurse through renderInline.
  if (/^https?:\/\//i.test(href)) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          void openUrl(href);
        }}
        className="inline-flex items-center gap-0.5 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {label}
        <HugeiconsIcon
          icon={ArrowUpRight01Icon}
          size={9}
          strokeWidth={2}
          className="translate-y-[1px] opacity-70"
        />
      </button>
    );
  }
  // Fall-through — render plainly so we don't swallow custom hrefs.
  return <span className="underline decoration-dotted underline-offset-2">{label}</span>;
}
