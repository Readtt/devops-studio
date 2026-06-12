import { cn } from "@/lib/utils";
import { useId } from "react";

/**
 * Hand-traced Azure DevOps infinity-loop mark. Kept around for the
 * Plans-panel project switcher where the user specifically asked to
 * preserve the original quiet glyph — it sits next to the project
 * name as an identity marker, not a brand surface, so the full
 * gradient logo would be too loud.
 *
 * For the section header, status bar, and Settings tab glyph (places
 * where the brand should read as "Azure DevOps the platform"), use
 * `AzureDevOpsBrand` instead — the official mark, inlined from
 * thesvg.org.
 *
 * Pass `mono` when the icon sits inside a high-density text run and
 * should inherit currentColor for legibility rather than render the
 * brand gradient.
 */
export function AzureDevOpsLogo({
  size = 14,
  className,
  mono = false,
  title = "Azure DevOps",
}: {
  size?: number;
  className?: string;
  mono?: boolean;
  title?: string;
}) {
  // Per-instance id so multiple copies (or a mono copy unmounting before a
  // gradient copy) can't collide on a shared SVG def.
  const gradientId = useId();
  return (
    <svg
      role="img"
      aria-label={title}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={mono ? "currentColor" : `url(#${gradientId})`}
      className={cn("shrink-0", className)}
    >
      <path d="M15 3.622v8.512L11.5 15l-5.425-1.975v1.958L3.004 10.97l8.951.7V4.005L15 3.622zm-2.984.428L6.994 1v2.001L2.382 4.356 1 6.13v4.029l1.978.873V5.869l9.038-1.818z" />
      {!mono ? (
        <defs>
          <linearGradient
            id={gradientId}
            x1="8"
            x2="8"
            y1="14.956"
            y2="1.026"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#0078D4" />
            <stop offset=".16" stopColor="#1380DA" />
            <stop offset=".53" stopColor="#3C91E5" />
            <stop offset=".82" stopColor="#559CEC" />
            <stop offset="1" stopColor="#5EA0EF" />
          </linearGradient>
        </defs>
      ) : null}
    </svg>
  );
}
