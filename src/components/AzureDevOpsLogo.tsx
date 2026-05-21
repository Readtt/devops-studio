import { cn } from "@/lib/utils";

/**
 * Official Azure DevOps mark. Uses Microsoft's published gradient path so
 * the connected-state indicator in the status bar reads as the platform
 * we're built on, not a generic cloud-server glyph.
 *
 * Pass `mono` when the icon sits inside a high-density text run and should
 * inherit currentColor for legibility (e.g. inside a button label) rather
 * than render the brand gradient.
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
  const gradientId = "ado-logo-grad";
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
