import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { MoreHorizontalCircle01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  FEATURED_PROMPTS,
  OVERFLOW_PROMPTS,
  type QuickPromptDef,
} from "./quickPrompts";
import { getSession } from "./terminalRegistry";
import { encodeForPty, writePty } from "./usePtySession";

/** Priority order when picking a sensible default base. Mirrors the Rust
 *  side's `DEFAULT_BASES` so the terminal's "review vs main" prompt lines
 *  up with what the Code Review pane chooses on the same repo. */
const BASE_PRIORITY = ["main", "master", "develop", "trunk"] as const;

function pickDefaultBase(branches: string[]): string | null {
  if (branches.length === 0) return null;
  // Local branches win over `origin/main` etc — calling out a remote ref
  // by name in the prompt is correct but reads weirder, so prefer the
  // local copy when present.
  for (const candidate of BASE_PRIORITY) {
    if (branches.includes(candidate)) return candidate;
  }
  // Fall back to whichever remote-tracking ref matches our priority list.
  for (const candidate of BASE_PRIORITY) {
    const remote = branches.find((b) => b.endsWith(`/${candidate}`));
    if (remote) return remote;
  }
  return null;
}

type Props = {
  /** Session id of the PTY this strip writes into. */
  sessionId: string;
  /** Working directory of THIS terminal. The base-branch detection has to run
   *  against the repo the shell is actually sitting in — reading the global
   *  primary repo instead is how a terminal opened in one repo ended up with
   *  another repo's branches baked into its prompt templates. */
  cwd: string | null;
};

/**
 * Thin chip strip above the xterm viewport. Clicking a chip types the
 * prompt into the terminal without auto-submitting — the user always sees
 * the text before pressing Enter, which is the difference between "AI
 * launchpad" and "guess what just got run".
 *
 * The chips read the user's preferred AI CLI from preferences and bake it
 * into the typed text via each prompt's `command` builder.
 */
export function QuickPromptsStrip({ sessionId, cwd }: Props) {
  const cli = usePreferencesStore((s) => s.preferredAiCli);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Detected default base branch for this terminal's own directory, refreshed
  // when it changes. Null = not a git repo (or detection failed) — prompts
  // that mention a base fall back to "the default branch" copy so they still
  // read sensibly without lying.
  const [baseBranch, setBaseBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      setBaseBranch(null);
      return;
    }
    let cancelled = false;
    invoke<string[]>("git_branch_list", { cwd })
      .then((branches) => {
        if (cancelled) return;
        setBaseBranch(pickDefaultBase(branches));
      })
      .catch(() => {
        // Not a git repo / git missing / permission denied. Bail to null so
        // the chips fall back to generic "default branch" copy.
        if (!cancelled) setBaseBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const handleType = (prompt: QuickPromptDef) => {
    // Clear whatever the LAST chip typed before typing the new prompt —
    // otherwise clicking chip B after chip A produces nonsense like
    // `claude "Review" claude "Tests"` on the same line.
    //
    // We send N backspaces (\b == \x08) where N is the length of the
    // last chip's text. Backspace is the only kill-to-start sequence
    // every shell line editor honours uniformly — Ctrl-U (\x15) and
    // Esc work on Unix readlines but PowerShell prints them as literal
    // `^U` / `^[`. The session's tracker resets to 0 whenever the user
    // types directly, so if they've appended to a prior chip's text we
    // skip the backspace path (and leave them a messy line to clean up
    // manually — better than eating their keystrokes).
    const session = getSession(sessionId);
    const prior = session?.lastChipTypedLength ?? 0;
    const body = prompt.command({ cli, baseBranch });
    const text = "\b".repeat(prior) + body;
    if (session) session.lastChipTypedLength = body.length;
    void writePty(sessionId, encodeForPty(text)).catch((e) => {
      console.warn("[quick-prompts] write failed:", e);
    });
  };

  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 border-b border-border/40 px-2",
        // Strip blends into the OLED background in dark mode and sits at a
        // very subtle lift in light mode — never competes with terminal
        // content underneath.
        "bg-background/80 dark:bg-background",
      )}
    >
      <span className="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        Quick
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {FEATURED_PROMPTS.map((p) => (
          <PromptChip
            key={p.id}
            prompt={p}
            onActivate={() => handleType(p)}
          />
        ))}
      </div>
      {OVERFLOW_PROMPTS.length > 0 ? (
        <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="More quick prompts"
                  className={cn(
                    "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
                    "text-muted-foreground transition-colors",
                    "hover:bg-foreground/[0.06] hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={MoreHorizontalCircle01Icon}
                    size={14}
                    strokeWidth={1.75}
                  />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              More prompts
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={4}
          >
            <span className="block px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              More prompts
            </span>
            {OVERFLOW_PROMPTS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  handleType(p);
                  setOverflowOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  "hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:bg-foreground/[0.05]",
                )}
              >
                <span className="text-[12px] font-medium">{p.label}</span>
                <span className="text-[10.5px] leading-snug text-muted-foreground">
                  {p.description}
                </span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function PromptChip({
  prompt,
  onActivate,
}: {
  prompt: QuickPromptDef;
  onActivate: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onActivate}
          className={cn(
            "flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-[11px]",
            // Light mode gets a hairline border for separation against the
            // off-white background; dark mode drops the border in favour of
            // a subtle muted fill so the chips don't look ringed on OLED.
            "border border-border/60 bg-card/70 text-foreground/85",
            "dark:border-transparent dark:bg-foreground/[0.05]",
            "transition-colors duration-100",
            "hover:bg-card hover:text-foreground hover:border-border",
            "dark:hover:bg-foreground/[0.09]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          )}
        >
          {prompt.label}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="max-w-72 text-[11px] leading-snug"
      >
        {prompt.description}
      </TooltipContent>
    </Tooltip>
  );
}
