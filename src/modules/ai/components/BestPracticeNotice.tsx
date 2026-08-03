// Shows what the last run's best-practices load skipped or truncated, next to
// the context meter on every AI surface.
//
// This is the one failure the run's own output can't reveal: the AI just stops
// following a house rule and the cases look plausible. Settings flags an
// oversized file before it's ever used, but a path that went offline between
// runs only shows up here.

import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { useBestPracticeWarnings } from "@/modules/ai/store/bestPracticeWarnings";
import { InlineNotice } from "@/modules/generator/components/InlineNotice";

export function BestPracticeNotice({ className }: { className?: string }) {
  const warnings = useBestPracticeWarnings((s) => s.warnings);
  const dismissed = useBestPracticeWarnings((s) => s.dismissed);
  const dismiss = useBestPracticeWarnings((s) => s.dismiss);
  if (dismissed || warnings.length === 0) return null;

  return (
    <InlineNotice
      tone="warning"
      role="status"
      icon={AlertCircleIcon}
      label={
        warnings.length === 1
          ? "best practices"
          : `best practices · ${warnings.length} files`
      }
      hint="Fix these in Settings → Models → Best practices. Until then the AI is working without those rules."
      onDismiss={dismiss}
      dismissLabel="Dismiss until this changes"
      className={className}
    >
      <ul className="flex flex-col gap-0.5">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </InlineNotice>
  );
}
