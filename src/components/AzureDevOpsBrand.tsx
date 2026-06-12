import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Official Azure DevOps brand mark — gradient and path transcribed from
 * thesvg.org's Azure DevOps icon (the same asset @thesvg/react ships).
 * Inlined per the brand-icon convention (CLAUDE.md → Brand icons #2):
 * importing the @thesvg/react barrel defeated tree-shaking and shipped a
 * ~420 kB lazy chunk for this one glyph. License is nominative fair use
 * for identification, per thesvg.org's terms.
 *
 * Used on surfaces where the icon represents the platform itself — Settings
 * section header, status-bar connected indicator, Settings tab glyph.
 *
 * The Plans-panel project switcher intentionally keeps the older
 * hand-traced `<AzureDevOpsLogo>` — see comment there.
 */
export function AzureDevOpsBrand({
  size = 14,
  className,
  title = "Azure DevOps",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  // Per-instance gradient id so multiple copies don't collide on one def.
  const gradientId = useId();
  return (
    <svg
      role="img"
      aria-label={title}
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="9"
          y1="16.97"
          x2="9"
          y2="1.03"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#0078d4" />
          <stop offset="0.16" stopColor="#1380da" />
          <stop offset="0.53" stopColor="#3c91e5" />
          <stop offset="0.82" stopColor="#559cec" />
          <stop offset="1" stopColor="#5ea0ef" />
        </linearGradient>
      </defs>
      <path
        d="M17,4v9.74l-4,3.28-6.2-2.26V17L3.29,12.41l10.23.8V4.44Zm-3.41.49L7.85,1V3.29L2.58,4.84,1,6.87v4.61l2.26,1V6.57Z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}
