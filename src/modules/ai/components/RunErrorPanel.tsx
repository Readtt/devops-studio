// Shared structured-error surface for the BYOK runs (Generator, Commit
// Review). One classification shape, one tone theme, one panel layout — so a
// rate-limited review and a rate-limited generation read identically, and the
// provider-bucket remediation copy can't drift between surfaces.
//
// Surfaces keep their own surface-specific branches (step caps, empty
// batches, publish failures) and fall back to classifyProviderError for the
// shared buckets: missing key, auth, credits, rate limit, overload, network,
// context overflow.

import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  AlertCircleIcon,
  Key01Icon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { matchErrorKind } from "@/modules/ai/lib/errorClass";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { cn } from "@/lib/utils";

export type ErrorClass = {
  /** Short uppercase code rendered in the header — terminal-flavored
   *  classification. Reads as a `grep`-able tag, not as casual copy. */
  code: string;
  /** Sentence-case title summarizing the failure. */
  title: string;
  /** Glyph in the left rail. Should map to the failure domain (key, plug,
   *  wifi, brain) rather than a generic warning triangle. */
  icon: typeof AlertCircleIcon;
  /** Short paragraph explaining what likely happened. Two sentences max. */
  why: string;
  /** Concrete next steps, ordered. */
  steps: string[];
  /** Tone the surface should adopt. */
  tone: "auth" | "config" | "network" | "validation" | "unknown";
  /** Primary action (e.g. open the right settings tab). */
  primary?: { label: string; icon: typeof AlertCircleIcon; onClick: () => void };
};

export const ERROR_TONE_THEME: Record<
  ErrorClass["tone"],
  {
    rail: string;
    iconBg: string;
    iconFg: string;
    codeText: string;
    dot: string;
  }
> = {
  auth: {
    rail: "border-amber-500/30 from-amber-500/[0.06]",
    iconBg: "bg-amber-500/10 ring-amber-500/30",
    iconFg: "text-amber-500 dark:text-amber-400",
    codeText: "text-amber-600 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  config: {
    rail: "border-sky-500/30 from-sky-500/[0.06]",
    iconBg: "bg-sky-500/10 ring-sky-500/30",
    iconFg: "text-sky-500 dark:text-sky-400",
    codeText: "text-sky-600 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  network: {
    rail: "border-orange-500/30 from-orange-500/[0.06]",
    iconBg: "bg-orange-500/10 ring-orange-500/30",
    iconFg: "text-orange-500 dark:text-orange-400",
    codeText: "text-orange-600 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  validation: {
    rail: "border-violet-500/30 from-violet-500/[0.06]",
    iconBg: "bg-violet-500/10 ring-violet-500/30",
    iconFg: "text-violet-500 dark:text-violet-400",
    codeText: "text-violet-600 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  unknown: {
    rail: "border-destructive/40 from-destructive/[0.06]",
    iconBg: "bg-destructive/10 ring-destructive/30",
    iconFg: "text-destructive",
    codeText: "text-destructive",
    dot: "bg-destructive",
  },
};

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Classify the provider-side failure buckets every BYOK surface shares.
 *  Returns null for anything surface-specific (empty batches, step caps,
 *  validation) — the caller supplies those branches itself. Routes through
 *  the shared `matchErrorKind` so this file and errorClass.ts can't drift on
 *  how the same message gets bucketed. */
export function classifyProviderError(message: string): ErrorClass | null {
  const lower = message.toLowerCase();

  if (
    /configure an api key/.test(lower) ||
    /no api key configured/.test(lower) ||
    /missing.*api.?key/.test(lower) ||
    /api key.*not.*set/.test(lower)
  ) {
    // Pull the provider's display label out of the message body. The
    // new error format reads "...needs Anthropic access — add a key…"
    // so we look for the brand label between "needs " and " access".
    // Falls back to the legacy "no api key configured for X" form for
    // any caller that hasn't been migrated to the new phrasing yet.
    const newFormat = message.match(/needs\s+([\w-]+)\s+access/i)?.[1];
    const legacyFormat = lower.match(/no api key configured for (\w+)/)?.[1];
    const providerLabel =
      newFormat ?? (legacyFormat ? capitalize(legacyFormat) : null);
    return {
      code: "AUTH/01 · MISSING-KEY",
      title: providerLabel
        ? `No ${providerLabel} API key on file`
        : "No API key on file for the selected model",
      icon: Key01Icon,
      tone: "auth",
      why: providerLabel
        ? `The model you have selected uses ${providerLabel}, but no ${providerLabel} key is stored in the keychain. You can either add the key, or switch to a model from a provider you've already configured — DevOps Studio works with any of them.`
        : "The active model needs an API key, and the keychain doesn't have one stored for that provider.",
      steps: [
        "Open Settings → Models and paste a key for that provider — or switch the active model to a provider you've already set up.",
        "Already added it? Check you saved it under the right provider: each provider (Anthropic, OpenAI, …) keeps its own separate key.",
      ],
      primary: {
        label: "Open AI / Models",
        icon: AiBrain01Icon,
        onClick: () => void openSettingsWindow("models"),
      },
    };
  }

  switch (matchErrorKind(message)) {
    case "context-overflow":
      return {
        code: "INPUT/02 · CONTEXT-OVERFLOW",
        title: "Too much input for this model's context window",
        icon: AiBrain01Icon,
        tone: "config",
        why: "The request outgrew the selected model's context window, so the provider rejected it before generating anything. Everything the run had already read is checkpointed and still recoverable.",
        steps: [
          "Resume — the work already done isn't re-run, and the transcript is compacted first so the request comes back smaller than the one that didn't fit.",
          "If it overflows again, trim the pasted text or split a very large job into separate runs.",
          "Remove large attachments — paste only the relevant excerpts.",
          "Or switch to a larger-context model for this run (e.g. one with a 1M-token window).",
        ],
        primary: {
          label: "Open AI / Models",
          icon: AiBrain01Icon,
          onClick: () => void openSettingsWindow("models"),
        },
      };

    case "no-credits":
      return {
        code: "PROVIDER/02 · NO-CREDITS",
        title: "Out of provider credits",
        icon: WifiDisconnected01Icon,
        tone: "network",
        why: "The provider rejected the request for billing reasons (402 / insufficient credits). This is not a key problem — your key is valid.",
        steps: [
          "Top up credits or check billing in the provider's console.",
          "Or switch to a model from a provider you have credit with.",
        ],
      };

    case "overloaded":
      return {
        code: "PROVIDER/03 · OVERLOADED",
        title: "The provider is temporarily overloaded",
        icon: WifiDisconnected01Icon,
        tone: "network",
        why: "The provider is temporarily overloaded or unavailable (502 / 503 / 529). This is on their side, not your key — and you're usually not billed for it.",
        steps: [
          "Wait a moment, then Resume — completed steps aren't re-run.",
          "If it keeps happening, try a different model or provider.",
        ],
      };

    case "rate-limit":
      return {
        code: "PROVIDER/01 · RATE-LIMIT",
        title: "Rate-limited by the provider",
        icon: WifiDisconnected01Icon,
        tone: "network",
        why: "You hit the provider's rate limit (429) — too many requests in a short window. Your key is fine.",
        steps: [
          "Wait a little, then Resume — the limit usually clears within a minute.",
          "Or switch to a less rate-limited model for this run.",
        ],
      };

    case "network":
      return {
        code: "NET/01 · UNREACHABLE",
        title: "Couldn't reach the model provider",
        icon: WifiDisconnected01Icon,
        tone: "network",
        why: "The HTTP request to the model API failed before a response came back. Most often this is no internet connection, a corporate proxy or VPN blocking the provider, transient DNS, or a wrong base URL on a custom provider.",
        steps: [
          "Check that this machine can reach the internet right now.",
          "On a VPN or proxy, confirm the provider's domain isn't blocked.",
          "Using a custom (OpenAI-compatible) provider? Double-check its base URL is reachable in Settings → Models.",
          "Then Resume — completed steps aren't re-run.",
        ],
      };

    case "auth":
      return {
        code: "AUTH/03 · REJECTED",
        title: "The provider rejected your credentials",
        icon: Key01Icon,
        tone: "auth",
        why: "The provider returned a 401/403. Either the stored API key is wrong, the key has been revoked, or your PAT needs SSO authorization.",
        steps: [
          "Regenerate the API key (or PAT) in the provider's console.",
          "Paste the new value into the relevant settings tab and retry.",
        ],
        primary: {
          label: "Open AI / Models",
          icon: AiBrain01Icon,
          onClick: () => void openSettingsWindow("models"),
        },
      };

    default:
      return null;
  }
}

/** The generic tail-end classification when nothing more specific matched. */
export function unclassifiedError(): ErrorClass {
  return {
    code: "RUN/00 · UNCLASSIFIED",
    title: "Something went wrong",
    icon: AlertCircleIcon,
    tone: "unknown",
    why: "The run failed before we could route it into a specific recovery path. The raw message from the underlying SDK is below — paste it into an issue if it keeps happening.",
    steps: ["Retry the run — or open the raw error below for the details."],
  };
}

/** The structured error surface: classification header band, numbered next
 *  steps, a collapsed raw-error excerpt, and the caller's action row. */
export function RunErrorPanel({
  klass,
  metaLabel,
  raw,
  rawLabel = "show raw error",
  children,
}: {
  klass: ErrorClass;
  /** Right-aligned mono label in the header band, e.g. "phase: analyze". */
  metaLabel?: string;
  /** Raw model/provider text behind the collapsed details block. */
  raw?: string | null;
  rawLabel?: string;
  /** Action row rendered under the panel (Resume / Re-run / settings). */
  children?: ReactNode;
}) {
  const theme = ERROR_TONE_THEME[klass.tone];
  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "overflow-hidden rounded-md border bg-gradient-to-br to-transparent",
          theme.rail,
        )}
      >
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-background/40 px-3 py-1.5 backdrop-blur-sm">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full shadow-[0_0_6px_-1px]",
              theme.dot,
            )}
          />
          <span
            className={cn(
              "font-mono text-[10px] font-medium tracking-wider uppercase",
              theme.codeText,
            )}
          >
            {klass.code}
          </span>
          {metaLabel ? (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
              {metaLabel}
            </span>
          ) : null}
        </div>

        <div className="flex items-start gap-3 px-4 py-4">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md ring-1",
              theme.iconBg,
            )}
          >
            <HugeiconsIcon
              icon={klass.icon}
              size={18}
              strokeWidth={1.5}
              className={theme.iconFg}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight">
              {klass.title}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {klass.why}
            </p>
          </div>
        </div>
      </div>

      {klass.steps.length > 0 ? (
        <div className="rounded-md border border-border/60 bg-card/40">
          <div className="flex items-center gap-1.5 border-b border-border/40 bg-foreground/[0.02] px-3 py-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              next steps
            </span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
              {klass.steps.length.toString().padStart(2, "0")} action
              {klass.steps.length === 1 ? "" : "s"}
            </span>
          </div>
          <ol className="flex flex-col">
            {klass.steps.map((step, i) => (
              <li
                key={i}
                className={cn(
                  "grid grid-cols-[auto_1fr] items-start gap-2.5 px-3 py-2",
                  i < klass.steps.length - 1 && "border-b border-border/30",
                )}
              >
                <span className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                <span className="text-[11.5px] leading-relaxed text-foreground/85">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {raw && raw.trim() ? (
        <details className="rounded-md border border-border/60 bg-card/40">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-foreground">
            <HugeiconsIcon icon={AlertCircleIcon} size={10} strokeWidth={1.75} />
            {rawLabel}
          </summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-border/30 bg-background/40 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            {raw}
          </pre>
        </details>
      ) : null}

      {children}
    </div>
  );
}
