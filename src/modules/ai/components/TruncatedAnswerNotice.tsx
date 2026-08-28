// Banner for a run whose answer was CUT OFF mid-write but still parsed into
// something worth showing.
//
// The empty-batch path already classifies a truncation as an error and offers a
// resume. A PARTIAL one has no such surface: the salvager keeps whatever
// completed and the pane renders it like any other result. That is the failure
// mode this exists for — every one of our schemas writes its least-important
// array LAST (DraftBatch puts `bugs` after `cases`), so a cut takes the tail
// and the pane cannot tell "the model found nothing there" apart from "the
// model never got to write it".
//
// On the custom endpoint the banner also names the fix, because there the cap
// is a setting. "Let the endpoint decide" is not neutral: an OpenAI-compatible
// proxy in front of Anthropic MUST invent a `max_tokens` (the upstream API
// requires one) and the invented number is small — 8k against the 64k the same
// model gets on its native route.

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";

type Props = {
  /** Output-token limit the cut-off request asked for. Undefined ⇒ we asked for
   *  nothing and the endpoint chose its own, which is a different sentence to
   *  the reader than a limit they set themselves. */
  outputCap?: number;
  /** True when the run used the custom OpenAI-compatible route, whose cap is a
   *  user setting rather than a table entry. */
  isCustomEndpoint: boolean;
  /** What this surface writes last, named so the reader knows what to distrust
   *  — e.g. "bug suggestions" or "the lowest-severity findings". */
  tailLabel: string;
};

export function TruncatedAnswerNotice({
  outputCap,
  isCustomEndpoint,
  tailLabel,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  // Only the custom route has a user-settable cap, so only it gets told to go
  // set one. A catalogued model that truncated at a known cap is a different
  // problem (the answer was genuinely too long) and pointing at Settings there
  // would send the user somewhere with nothing to change.
  //
  // NOT also gated on `outputCap === undefined`: a custom endpoint that
  // truncated at a cap the user already set needs that setting RAISED, which
  // is the same one click. Gating on it hid the action from the second-most
  // likely person to need it.
  const canSetCap = isCustomEndpoint;

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={12}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="leading-relaxed">
          <span className="font-medium">The model&apos;s answer was cut off</span>{" "}
          before it finished writing. What you see below is the part that
          arrived — {tailLabel} come last, so treat an empty list there as
          &ldquo;never written&rdquo; rather than &ldquo;none found&rdquo;.
          {outputCap === undefined ? (
            <>
              {" "}
              This run sent no output-token limit, so your endpoint used its own
              — often far smaller than the model allows.
            </>
          ) : (
            <> It stopped at the {outputCap.toLocaleString()}-token limit.</>
          )}
        </p>
        {canSetCap ? (
          <div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void openSettingsWindow("models")}
                  className="border-amber-500/40 bg-transparent hover:bg-amber-500/10"
                >
                  {outputCap === undefined
                    ? "Set a max output limit"
                    : "Raise the max output limit"}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="max-w-[300px] text-[11px]"
              >
                Opens Settings → Models, where &ldquo;Max output&rdquo; on your
                custom endpoint sets the room every answer gets. Raise it until
                answers stop being cut off — the field explains how far is
                safe.
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
            className="-mr-1 -mt-0.5 size-5 shrink-0 text-amber-700/70 hover:text-amber-700 dark:text-amber-300/70 dark:hover:text-amber-300"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Dismiss this notice
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
