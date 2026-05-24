// Shared provider-icon component reusable across the main window and
// settings window. The settings module re-exports this from its own
// folder for backward compatibility with existing import paths.
//
// Resolution chain:
//   1. simple-icons via BrandIcon — real brand mark in official colour.
//      Used for providers that ship a mark we can carry (Anthropic,
//      Google, DeepSeek, Mistral, Ollama, OpenRouter, Apple/MLX).
//   2. hugeicons fallback — stroke glyph for providers simple-icons
//      doesn't carry (OpenAI / xAI / Cerebras / Groq — trademark-
//      restricted; LMStudio / openai-compatible — no canonical mark).
//
// Branded vs mono is decided by the consumer. Quiet surfaces (status
// bar) usually want mono; identity surfaces (model picker, settings)
// want branded.

import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import type { ProviderId } from "@/modules/ai/config";
import {
  AppleIcon,
  ChatGptIcon,
  ComputerIcon,
  CpuIcon,
  FlashIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  PlugIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** Providers we render via simple-icons BrandIcon. Order matches
 *  ProviderId so the mapping is exhaustively checked. */
const SIMPLE_ICON_BRAND: Partial<Record<ProviderId, BrandName>> = {
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  mistral: "mistral",
  ollama: "ollama",
  openrouter: "openrouter",
  mlx: "apple",
};

/** hugeicons fallback for providers without a simple-icons mark. */
const HUGEICONS_FALLBACK = {
  openai: ChatGptIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  // Defensive completeness — the entries below should be unreachable
  // because SIMPLE_ICON_BRAND covers them. Keeping them prevents a
  // runtime undefined-icon crash if the simple-icons mapping ever
  // diverges from ProviderId.
  anthropic: ChatGptIcon,
  google: GoogleGeminiIcon,
  deepseek: ChatGptIcon,
  mistral: ChatGptIcon,
  ollama: ServerStack01Icon,
  openrouter: ChatGptIcon,
  mlx: AppleIcon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

type Props = {
  provider: ProviderId;
  size?: number;
  className?: string;
  /** When true (default), use the brand's official colour where the
   *  source supports it (simple-icons hex with the near-black inheritance
   *  rule). Pass false for quiet surfaces — the status bar, list
   *  separators — where the icon should pick up text colour. */
  branded?: boolean;
};

export function ProviderIcon({
  provider,
  size = 14,
  className,
  branded = true,
}: Props) {
  const brand = SIMPLE_ICON_BRAND[provider];
  if (brand) {
    return (
      <BrandIcon
        name={brand}
        size={size}
        branded={branded}
        className={className}
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={HUGEICONS_FALLBACK[provider]}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
