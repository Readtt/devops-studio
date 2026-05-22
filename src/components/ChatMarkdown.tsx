import { Fragment, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Minimal markdown renderer tuned for chat assistant messages. Covers the
 * cases the analyst actually emits — paragraphs, bullets / numbered lists,
 * **bold**, *italic*, `inline code`, ```fenced code```, [links](href),
 * headings (#, ##, ###), and blockquotes. Tables and HTML pass through as
 * literal text by design — the chat layer doesn't need them and a full
 * CommonMark parser would mean another dep.
 *
 * The fenced-code block additionally gets a hover-copy button and a
 * language chip in the corner; this is the affordance the user is most
 * likely to use day-to-day (lifting a snippet into a test step or bug
 * repro). Inline code stays plain.
 */
/** Action surface for chat-message-embedded "devops-edit" fences. Called
 *  with the parsed JSON payload from the block. The caller decides what
 *  to do (validate, call ADO, render success state). When omitted, the
 *  block falls back to rendering as a normal fenced code preview. */
export type ApplyEditHandler = (payload: unknown) => Promise<ApplyEditResult>;

export type ApplyEditResult = {
  ok: boolean;
  message?: string;
};

export function ChatMarkdown({
  source,
  className,
  onApplyEdit,
}: {
  source: string;
  className?: string;
  onApplyEdit?: ApplyEditHandler;
}) {
  const blocks = parseBlocks(source);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {blocks.map((b, i) => (
        <BlockRenderer key={i} block={b} onApplyEdit={onApplyEdit} />
      ))}
    </div>
  );
}

// --- Block grammar ----------------------------------------------------------

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbered"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string | null; body: string }
  | { kind: "hr" };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code — preserve interior verbatim, no other parsing inside.
    const fence = line.match(/^```(\w[\w-]*)?\s*$/);
    if (fence) {
      const lang = fence[1] ?? null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or EOF)
      out.push({ kind: "code", lang, body: body.join("\n") });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      out.push({ kind: "heading", level, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "bullets", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "numbered", items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", text: quoted.join(" ") });
      continue;
    }
    // Paragraph — coalesce consecutive non-blank lines.
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
    out.push({ kind: "paragraph", text: para.join(" ") });
  }
  return out;
}

function BlockRenderer({
  block,
  onApplyEdit,
}: {
  block: Block;
  onApplyEdit?: ApplyEditHandler;
}) {
  switch (block.kind) {
    case "heading": {
      const size =
        block.level === 1
          ? "text-[14px] font-semibold"
          : block.level === 2
            ? "text-[13px] font-semibold"
            : "text-[12.5px] font-medium";
      return <p className={cn(size, "leading-snug")}>{renderInline(block.text)}</p>;
    }
    case "paragraph":
      return (
        <p className="text-[12px] leading-relaxed">{renderInline(block.text)}</p>
      );
    case "bullets":
      return (
        <ul className="ml-4 list-disc text-[12px] leading-relaxed marker:text-muted-foreground/55">
          {block.items.map((t, i) => (
            <li key={i}>{renderInline(t)}</li>
          ))}
        </ul>
      );
    case "numbered":
      return (
        <ol className="ml-4 list-decimal text-[12px] leading-relaxed marker:text-muted-foreground/55">
          {block.items.map((t, i) => (
            <li key={i}>{renderInline(t)}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <p className="border-l-2 border-border/60 pl-2 text-[11.5px] italic text-muted-foreground">
          {renderInline(block.text)}
        </p>
      );
    case "hr":
      return <hr className="border-border/40" />;
    case "code":
      if (block.lang === "devops-edit" && onApplyEdit) {
        return <ApplyEditCard body={block.body} onApply={onApplyEdit} />;
      }
      return <CodeBlock lang={block.lang} body={block.body} />;
  }
}

/**
 * Special rendering for `devops-edit` fenced blocks. Shows a compact summary
 * of the proposed change and an Apply button that posts to ADO via the
 * caller-provided handler. Maintains its own local state: idle → applying
 * → ok | error. The error case keeps the Apply button visible so a flaky
 * network doesn't strand the user — they can hit Apply again.
 */
function ApplyEditCard({
  body,
  onApply,
}: {
  body: string;
  onApply: ApplyEditHandler;
}) {
  const [state, setState] = useState<"idle" | "applying" | "ok" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => safeParse(body), [body]);

  const onClick = async () => {
    if (state === "applying" || state === "ok") return;
    if (!parsed.ok) {
      setState("error");
      setMessage(parsed.error);
      return;
    }
    setState("applying");
    setMessage(null);
    try {
      const result = await onApply(parsed.value);
      if (result.ok) {
        setState("ok");
        setMessage(result.message ?? "Applied to ADO.");
      } else {
        setState("error");
        setMessage(result.message ?? "Couldn't apply.");
      }
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const summary = parsed.ok ? summarizeEdit(parsed.value) : "Suggested edit";
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border text-[11.5px]",
        state === "ok"
          ? "border-emerald-500/40 bg-emerald-500/[0.06]"
          : state === "error"
            ? "border-destructive/40 bg-destructive/[0.06]"
            : "border-primary/30 bg-primary/[0.04]",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <span
          className={cn(
            "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm font-mono text-[9px] uppercase tracking-wider",
            state === "ok"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : state === "error"
                ? "bg-destructive/15 text-destructive"
                : "bg-primary/15 text-primary",
          )}
        >
          {state === "ok" ? (
            <HugeiconsIcon icon={Tick02Icon} size={10} strokeWidth={2} />
          ) : (
            "edit"
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-medium leading-snug">{summary}</p>
          {message ? (
            <p
              className={cn(
                "mt-0.5 text-[10.5px] leading-relaxed",
                state === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {message}
            </p>
          ) : null}
        </div>
        {state !== "ok" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClick}
                disabled={state === "applying" || !parsed.ok}
                className={cn(
                  "shrink-0 rounded-sm border px-2 py-1 text-[10.5px] font-medium transition-colors",
                  state === "applying"
                    ? "border-border/40 bg-foreground/[0.04] text-muted-foreground"
                    : state === "error"
                      ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                      : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
                )}
              >
                {state === "applying"
                  ? "Applying…"
                  : state === "error"
                    ? "Retry"
                    : "Apply to ADO"}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[11px]">
              {parsed.ok
                ? "Send this change to Azure DevOps — the case will be updated in place."
                : "This edit block is malformed and can't be applied."}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full border-t border-border/30 bg-foreground/[0.02] px-2.5 py-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? "Hide raw payload" : "Show raw payload"}
      </button>
      {expanded ? (
        <pre className="max-h-40 overflow-auto border-t border-border/30 bg-background/40 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          <code>{body}</code>
        </pre>
      ) : null}
    </div>
  );
}

function safeParse(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "JSON parse failed",
    };
  }
}

function summarizeEdit(value: unknown): string {
  if (!value || typeof value !== "object") return "Suggested edit";
  const v = value as Record<string, unknown>;
  const kind = typeof v.kind === "string" ? v.kind : "unknown";
  const caseId = typeof v.caseId === "number" ? v.caseId : null;
  if (kind === "rename" && typeof v.title === "string") {
    return `Rename case ${caseId ? `#${caseId}` : ""} → "${truncate(v.title, 60)}"`;
  }
  if (kind === "rewrite-steps") {
    const n = Array.isArray(v.steps) ? v.steps.length : 0;
    return `Rewrite steps on ${caseId ? `case #${caseId}` : "a case"} (${n} step${n === 1 ? "" : "s"})`;
  }
  return `Suggested edit (${kind})`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function CodeBlock({ lang, body }: { lang: string | null; body: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // ignore — non-secure context or permission denied
    }
  };
  return (
    <div className="group/code relative overflow-hidden rounded-md border border-border/50 bg-foreground/[0.04]">
      {lang ? (
        <span className="absolute right-9 top-1 select-none rounded-sm bg-foreground/[0.06] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground/85">
          {lang}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy code"
            className={cn(
              "absolute right-1.5 top-1 grid size-5 place-items-center rounded-sm transition-colors",
              "opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100",
              copied
                ? "bg-primary/15 text-primary opacity-100"
                : "text-muted-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={10}
              strokeWidth={1.75}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[11px]">
          {copied ? "Copied" : "Copy code"}
        </TooltipContent>
      </Tooltip>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
        <code>{body}</code>
      </pre>
    </div>
  );
}

// --- Inline span renderer ---------------------------------------------------

/**
 * Render inline markup inside paragraph / heading / list-item content. The
 * grammar we support: `inline code`, **bold**, *italic*, [text](href). All
 * tokenized in one left-to-right pass so e.g. **a*b*c** behaves sensibly.
 */
function renderInline(input: string): ReactNode {
  const nodes: ReactNode[] = [];
  let key = 0;
  let i = 0;
  while (i < input.length) {
    // Inline code — highest precedence so backticks inside ** don't pair.
    if (input[i] === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        nodes.push(
          <code
            key={key++}
            className="rounded-sm bg-foreground/[0.08] px-1 py-px font-mono text-[11px]"
          >
            {input.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    // Link [text](url) — both ADO web URLs and code-viewer dispatches.
    if (input[i] === "[") {
      const close = findUnescaped(input, "]", i + 1);
      if (close !== -1 && input[close + 1] === "(") {
        const paren = findUnescaped(input, ")", close + 2);
        if (paren !== -1) {
          const text = input.slice(i + 1, close);
          const href = input.slice(close + 2, paren).trim();
          nodes.push(
            <button
              key={key++}
              type="button"
              onClick={() => {
                if (href.startsWith("http")) void openUrl(href);
                else if (href.startsWith("/")) void openUrl(href); // unhandled, falls through
              }}
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              {text}
            </button>,
          );
          i = paren + 1;
          continue;
        }
      }
    }
    // Bold (**) — pair eagerly within line.
    if (input[i] === "*" && input[i + 1] === "*") {
      const end = input.indexOf("**", i + 2);
      if (end > i) {
        nodes.push(
          <strong key={key++} className="font-semibold">
            {renderInline(input.slice(i + 2, end))}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }
    // Italic (*) — single-star; skip when it's actually a bullet/list marker
    // (caller has already split paragraphs, so this is purely inline).
    if (input[i] === "*") {
      const end = input.indexOf("*", i + 1);
      if (end > i) {
        nodes.push(
          <em key={key++} className="italic">
            {renderInline(input.slice(i + 1, end))}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }
    // Plain run — accumulate until next markup char.
    const next = nextMarkupIndex(input, i + 1);
    nodes.push(
      <Fragment key={key++}>{input.slice(i, next)}</Fragment>,
    );
    i = next;
  }
  return nodes;
}

function findUnescaped(s: string, needle: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++; // skip escaped char
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
