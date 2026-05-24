import { useId } from "react";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { cn } from "@/lib/utils";

/**
 * Unified shell-glyph picker used everywhere a shell needs a visual mark
 * (Settings → Terminal picker, future per-tab indicators, etc).
 *
 * Resolution chain:
 *   - bash / zsh / fish / git-bash → simple-icons via BrandIcon
 *   - pwsh / powershell           → inline brand SVG from thesvg.org
 *                                   (CC-licensed nominative-fair-use icon)
 *   - cmd                         → hand-rendered "DOS prompt" tile —
 *                                   Microsoft doesn't ship a cmd logo and
 *                                   simple-icons / thesvg.org don't carry
 *                                   one either; this gives the picker an
 *                                   on-brand-looking tile instead of a
 *                                   generic arrow.
 *   - sh / other                  → minimal terminal-prompt arrow glyph.
 */

const SIMPLE_ICONS_BY_KIND: Record<string, BrandName | undefined> = {
  bash: "bash",
  zsh: "zsh",
  fish: "fish",
  "git-bash": "git-bash",
};

export function ShellBrandIcon({
  kind,
  size = 14,
  className,
}: {
  kind: string;
  size?: number;
  className?: string;
}) {
  const brand = SIMPLE_ICONS_BY_KIND[kind];
  if (brand) {
    return <BrandIcon name={brand} size={size} className={className} />;
  }
  if (kind === "pwsh" || kind === "powershell") {
    return <PowerShellGlyph size={size} className={className} />;
  }
  if (kind === "cmd") {
    return <CmdGlyph size={size} className={className} />;
  }
  return <FallbackPromptGlyph size={size} className={className} />;
}

/**
 * PowerShell brand mark — gradients and proportions transcribed from
 * thesvg.org's `/icons/powershell/default.svg`. Licensed as "property of
 * Microsoft, provided for identification under nominative fair use" per
 * thesvg.org's terms. Gradient IDs are scoped to this component so two
 * instances on the same page don't share an `#a` / `#b` definition (which
 * would cause one to disappear).
 */
function PowerShellGlyph({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  // Gradient ids need to be unique per instance so two copies of the icon
  // on the same page don't share `#a` / `#b` defs (which silently makes
  // one of them disappear). useId is React 18's stable-per-mount answer
  // and works fine in a Tauri client-only render.
  const id = useId();
  const bg = `psh-bg-${id}`;
  const fg = `psh-fg-${id}`;
  return (
    <svg
      role="img"
      aria-label="PowerShell"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    >
      <linearGradient
        id={bg}
        x1="96.306"
        x2="25.454"
        y1="35.144"
        y2="98.431"
        gradientTransform="matrix(1 0 0 -1 0 128)"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#a9c8ff" />
        <stop offset="1" stopColor="#c7e6ff" />
      </linearGradient>
      <path
        fill={`url(#${bg})`}
        fillRule="evenodd"
        clipRule="evenodd"
        opacity=".8"
        d="M7.2 110.5c-1.7 0-3.1-.7-4.1-1.9-1-1.2-1.3-2.9-.9-4.6l18.6-80.5c.8-3.4 4-6 7.4-6h92.6c1.7 0 3.1.7 4.1 1.9 1 1.2 1.3 2.9.9 4.6l-18.6 80.5c-.8 3.4-4 6-7.4 6H7.2z"
      />
      <linearGradient
        id={fg}
        x1="25.336"
        x2="94.569"
        y1="98.33"
        y2="36.847"
        gradientTransform="matrix(1 0 0 -1 0 128)"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#2d4664" />
        <stop offset=".169" stopColor="#29405b" />
        <stop offset=".445" stopColor="#1e2f43" />
        <stop offset=".79" stopColor="#0c131b" />
        <stop offset="1" />
      </linearGradient>
      <path
        fill={`url(#${fg})`}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M120.3 18.5H28.5c-2.9 0-5.7 2.3-6.4 5.2L3.7 104.3c-.7 2.9 1.1 5.2 4 5.2h91.8c2.9 0 5.7-2.3 6.4-5.2l18.4-80.5c.7-2.9-1.1-5.3-4-5.3z"
      />
      <path
        fill="#FFF"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M77.6 65.5c-.4.8-1.2 1.6-2.6 2.6L33.6 97.9c-2.3 1.6-5.5 1-7.3-1.4-1.7-2.4-1.3-5.7.9-7.3l37.4-27.1v-.6l-23.5-25c-1.9-2-1.7-5.3.4-7.4 2.2-2 5.5-2 7.4 0l28.2 30c1.7 1.8 1.8 4.4.5 6.4zM63.5 87.8h22.3c2.6 0 4.7 2.1 4.7 4.6 0 2.6-2.1 4.6-4.7 4.6H63.5c-2.6 0-4.7-2.1-4.7-4.6 0-2.6 2.1-4.6 4.7-4.6z"
      />
    </svg>
  );
}

/**
 * Hand-rendered "Command Prompt" tile. Microsoft doesn't ship a cmd.exe
 * brand mark anywhere — not in simple-icons, not on thesvg.org. This is
 * a passable nod to the classic black-with-white-prompt aesthetic that
 * keeps the picker visually consistent with the real brand icons next
 * to it without pretending to be an official asset.
 */
function CmdGlyph({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Command Prompt"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    >
      <rect x="2" y="4" width="20" height="16" rx="2" fill="#0c0c0c" />
      <rect x="2" y="4" width="20" height="3" rx="2" fill="#2b2b2b" />
      <circle cx="4.3" cy="5.5" r="0.55" fill="#5e5e5e" />
      <circle cx="6" cy="5.5" r="0.55" fill="#5e5e5e" />
      <circle cx="7.7" cy="5.5" r="0.55" fill="#5e5e5e" />
      <path
        d="M5.4 11.2l2.7 2.4-2.7 2.4"
        stroke="#f4f4f4"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M9.4 16h6"
        stroke="#f4f4f4"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Last-resort glyph for `sh` and the catch-all `other`. */
function FallbackPromptGlyph({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  return (
    <svg
      role="img"
      aria-label="Shell"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-muted-foreground", className)}
    >
      <path d="M4 7l4 5-4 5" />
      <path d="M12 17h8" />
    </svg>
  );
}

