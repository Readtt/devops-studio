// A quiet "it's not frozen" line for the busy states. The task runner retries
// transient provider failures with backoff (up to ~2 minutes) before erroring
// — correct behavior, but from the outside a run with a dead connection just
// sits there with a frozen activity log, which reads as "resume didn't work".
// This surfaces after PROGRESS (not time) stops: any change to the signature
// resets the clock.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const STALL_AFTER_MS = 15_000;

export function StallHint({
  signature,
  className,
}: {
  /** Any value that changes when the run makes visible progress (activity
   *  count, step counter, stage, streamed text length…). */
  signature: unknown;
  className?: string;
}) {
  const [stalled, setStalled] = useState(false);
  const lastProgressRef = useRef(Date.now());

  useEffect(() => {
    lastProgressRef.current = Date.now();
    setStalled(false);
  }, [signature]);

  useEffect(() => {
    const t = window.setInterval(
      () => setStalled(Date.now() - lastProgressRef.current > STALL_AFTER_MS),
      1000,
    );
    return () => window.clearInterval(t);
  }, []);

  if (!stalled) return null;
  return (
    <p
      className={cn(
        "text-[10.5px] leading-snug text-muted-foreground/80",
        className,
      )}
    >
      No response from the provider yet — connection hiccups are retried
      automatically for a couple of minutes before the run errors.
    </p>
  );
}
