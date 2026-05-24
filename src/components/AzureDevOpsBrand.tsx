import { AzureAzureDevops } from "@thesvg/react";
import { cn } from "@/lib/utils";

/**
 * Official Azure DevOps brand mark, sourced from @thesvg/react. Used
 * on surfaces where the icon represents the platform itself — Settings
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
  return (
    <AzureAzureDevops
      aria-label={title}
      role="img"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  );
}
