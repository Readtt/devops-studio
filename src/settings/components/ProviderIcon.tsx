// Backward-compat re-export — settings code imports from this path. The
// canonical component lives under modules/ai/components so non-settings
// surfaces (status bar, generator) can reach it without crossing entry
// boundaries.

export { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
