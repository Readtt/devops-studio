import { cn } from "@/lib/utils";
import {
  siAnthropic,
  siGit,
  siGithub,
  siGoogle,
  siVercel,
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
} satisfies Record<string, SimpleIcon>;

export type BrandName = keyof typeof ICONS;

type Props = {
  name: BrandName;
  size?: number;
  className?: string;
  /** When true, paint the icon in the brand's official color. Default off
   *  so icons inherit the surrounding text color and stay legible in dark
   *  mode. */
  branded?: boolean;
  title?: string;
};

export function BrandIcon({
  name,
  size = 13,
  className,
  branded = false,
  title,
}: Props) {
  const icon = ICONS[name];
  return (
    <svg
      role="img"
      aria-label={title ?? icon.title}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={branded ? `#${icon.hex}` : "currentColor"}
      className={cn("shrink-0", className)}
    >
      <path d={icon.path} />
    </svg>
  );
}
