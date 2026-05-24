import { cn } from "@/lib/utils";
import {
  siAnthropic,
  siFishshell,
  siGit,
  siGithub,
  siGitforwindows,
  siGnubash,
  siGoogle,
  siVercel,
  siZsh,
  type SimpleIcon,
} from "simple-icons";

/**
 * Map between the brand names we use in the UI and the simple-icons exports.
 * Adding a brand: import its `si<Name>` export above, then add an entry here.
 * Tree-shaking keeps unused icons out of the bundle.
 *
 * Notes:
 * - simple-icons doesn't ship an OpenAI glyph (trademark restrictions) — the
 *   ProviderIcon component falls back to a hand-painted SVG for that one.
 * - Azure DevOps isn't in the upstream pack either, so the ADO indicator
 *   keeps using the hugeicons CloudServer icon.
 */
const ICONS = {
  anthropic: siAnthropic,
  git: siGit,
  github: siGithub,
  google: siGoogle,
  vercel: siVercel,
  // Shell brand marks for the terminal default-shell picker. Microsoft
  // PowerShell and cmd.exe aren't in simple-icons (trademark-restricted —
  // same reason OpenAI is missing), so the picker falls back to a generic
  // terminal glyph for those.
  bash: siGnubash,
  zsh: siZsh,
  fish: siFishshell,
  "git-bash": siGitforwindows,
} satisfies Record<string, SimpleIcon>;

export type BrandName = keyof typeof ICONS;

type Props = {
  name: BrandName;
  size?: number;
  className?: string;
  /** Default true: paint in the brand's official color, but with a
   *  near-black-detector that falls back to currentColor when the brand
   *  hex would vanish into the current background (looking at you,
   *  Anthropic #181818 and Vercel #000000 on dark mode). */
  branded?: boolean;
  title?: string;
};

/** Bytes-only luminance test on a 6-char hex. Brands ship official marks
 *  in pure black (Anthropic, Vercel, GitHub) which disappear on dark
 *  surfaces; this returns true for any color dark enough that we should
 *  inherit currentColor instead. */
function isNearBlack(hex: string): boolean {
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Perceptual-ish luma — Rec. 601 weights are close enough for this gate.
  return 0.299 * r + 0.587 * g + 0.114 * b < 32;
}

export function BrandIcon({
  name,
  size = 13,
  className,
  branded = true,
  title,
}: Props) {
  const icon = ICONS[name];
  const useCurrent = !branded || isNearBlack(icon.hex);
  return (
    <svg
      role="img"
      aria-label={title ?? icon.title}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={useCurrent ? "currentColor" : `#${icon.hex}`}
      className={cn("shrink-0", className)}
    >
      <path d={icon.path} />
    </svg>
  );
}
