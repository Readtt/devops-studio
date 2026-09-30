import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  PROVIDERS,
  findModel,
  getModel,
  type ModelId,
  type ModelInfo,
} from "@/modules/ai/config";
import { ProviderIcon } from "./ProviderIcon";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  pushRecentModel,
  toggleFavoriteModel,
} from "@/modules/ai/lib/modelPrefs";
import { useSelectableModels } from "@/modules/ai/lib/modelAvailability";
import { StarIcon, StarHalfIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type ModelPickerFilter = (modelId: ModelId) => boolean;

/** Discovered models shown per provider before the user types. OpenRouter
 *  alone lists hundreds; a search reaches all of them. */
const DISCOVERED_PREVIEW = 5;

type Props = {
  value: ModelId;
  onChange: (id: ModelId) => void;
  /** Restrict the list to models the predicate returns true for. Use this for
   *  availability gating (only providers with keys / configured locals). */
  filter?: ModelPickerFilter;
  /** Disable the trigger and prevent opening the popover. */
  disabled?: boolean;
  /** Tooltip-quality reason text shown to disabled triggers via title. */
  disabledReason?: string;
  /** Render slot for the trigger button. Receives the resolved model label so
   *  callers can decide how compact to render it. */
  trigger: (state: {
    label: string;
    provider: (typeof PROVIDERS)[number]["id"];
    disabled: boolean;
  }) => React.ReactNode;
  /** Popover alignment — defaults to "end" (right-anchored for status-bar use). */
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /** Optional footer rendered below the model list — useful for "N locked"
   *  hints with a deep-link to settings. */
  footer?: React.ReactNode;
  /** Override the empty-state message (when the filter hides everything). */
  emptyMessage?: React.ReactNode;
};

export function ModelPicker({
  value,
  onChange,
  filter,
  disabled,
  disabledReason,
  trigger,
  align = "end",
  side = "top",
  footer,
  emptyMessage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const recents = usePreferencesStore((s) => s.recentModelIds);
  const favorites = usePreferencesStore((s) => s.favoriteModelIds);
  const models = useSelectableModels();
  const current = getModel(value);

  const visibleModels = useMemo(() => {
    const shown = models.filter((m) => (filter ? filter(m.id) : true));
    // The selected model always has a row, even when no list carries it any
    // more (a saved discovered pick whose provider hasn't answered yet).
    if (!shown.some((m) => m.id === value) && (!filter || filter(value))) {
      const selected = findModel(value);
      if (selected) shown.push(selected);
    }
    return shown;
  }, [models, filter, value]);

  // Curated first in catalogue order, then the provider's own list newest
  // first — the order `useSelectableModels` already hands them over in.
  const grouped = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of visibleModels) {
      const arr = byProvider.get(m.provider) ?? [];
      arr.push(m);
      byProvider.set(m.provider, arr);
    }
    return PROVIDERS.map((p) => ({
      provider: p,
      models: byProvider.get(p.id) ?? [],
    })).filter((g) => g.models.length > 0);
  }, [visibleModels]);

  const recentVisible = recents
    .map((id) => visibleModels.find((m) => m.id === id))
    .filter((m): m is ModelInfo => Boolean(m));

  const favoriteVisible = favorites
    .map((id) => visibleModels.find((m) => m.id === id))
    .filter((m): m is ModelInfo => Boolean(m));

  // Stable, so memoised rows don't all re-render on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onPick = useCallback((id: string) => {
    setOpen(false);
    onChangeRef.current(id as ModelId);
    void pushRecentModel(id);
  }, []);

  const isEmpty = visibleModels.length === 0;
  const searching = query.trim().length > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        // Reset on OPEN: a pick closes the popover without passing through
        // here, so resetting on close left the last search in the box.
        if (next) setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          className={cn(
            "outline-none",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {trigger({
            label: current.label,
            provider: current.provider,
            disabled: !!disabled,
          })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={12}
        avoidCollisions
        // Cap the popover at whatever room Radix calculated above/below the
        // trigger so it never overruns the settings window's visible area —
        // the inner CommandList scrolls instead of getting clipped by the
        // webview's bottom edge.
        className="w-[340px] p-0"
        style={{
          maxHeight: "min(440px, var(--radix-popover-content-available-height, 440px))",
        }}
      >
        <Command>
          <CommandInput
            placeholder="Search models…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList
            className="overscroll-contain"
            style={{
              maxHeight:
                "min(360px, calc(var(--radix-popover-content-available-height, 360px) - 80px))",
            }}
          >
            {isEmpty ? (
              <div className="px-3 py-6 text-center">
                <p className="text-[11.5px] text-foreground/85">
                  {emptyMessage ?? "No matching models."}
                </p>
              </div>
            ) : (
              <CommandEmpty>No models match.</CommandEmpty>
            )}
            {recentVisible.length > 0 ? (
              <>
                <CommandGroup heading="Recent">
                  {recentVisible.map((m) => (
                    <ModelRow
                      key={`recent-${m.id}`}
                      // cmdk uses `value` as the row identity for both search
                      // and selection state — if two rows share a value (the
                      // same model showing in "Recent" AND its provider group),
                      // hovering one highlights both. Section-prefix the value
                      // so each row is its own identity.
                      section="recent"
                      model={m}
                      selected={m.id === value}
                      favorite={favorites.includes(m.id)}
                      onPick={onPick}
                    />
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {favoriteVisible.length > 0 ? (
              <>
                <CommandGroup heading="Favorites">
                  {favoriteVisible.map((m) => (
                    <ModelRow
                      key={`fav-${m.id}`}
                      section="favorite"
                      model={m}
                      selected={m.id === value}
                      favorite
                      onPick={onPick}
                    />
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {grouped.map((g) => {
              // Unsearched, a provider shows its curated models, its newest
              // few discovered ones, and the selected model wherever it sits.
              let discoveredShown = 0;
              const rows = searching
                ? g.models
                : g.models.filter((m) => {
                    if (!m.discovered || m.id === value) return true;
                    return ++discoveredShown <= DISCOVERED_PREVIEW;
                  });
              const hidden = g.models.length - rows.length;
              return (
                <CommandGroup key={g.provider.id} heading={g.provider.label}>
                  {rows.map((m) => (
                    <ModelRow
                      key={m.id}
                      section={`provider:${g.provider.id}`}
                      model={m}
                      selected={m.id === value}
                      favorite={favorites.includes(m.id)}
                      onPick={onPick}
                    />
                  ))}
                  {hidden > 0 ? (
                    <p className="px-2 pt-0.5 pb-1.5 pl-[26px] text-[10.5px] text-muted-foreground/70">
                      {hidden} more from {g.provider.label} — type to search
                    </p>
                  ) : null}
                </CommandGroup>
              );
            })}
          </CommandList>
          {footer ? (
            <div className="border-t border-border/50 bg-card/40 px-2 py-1.5">
              {footer}
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const ModelRow = memo(function ModelRow({
  section,
  model,
  selected,
  favorite,
  onPick,
}: {
  /** Stable per-group token used to disambiguate the cmdk `value`. Rows from
   *  the same model in different groups (Recent vs Anthropic) get distinct
   *  values so hover state never leaks between them. */
  section: string;
  model: ModelInfo;
  selected: boolean;
  favorite: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <CommandItem
      // Section-prefixed value: cmdk filtering still matches the embedded
      // label/id/provider/hint/description text because the prefix is just a
      // discriminator, not the searchable surface — typing "sonnet" still
      // surfaces both Recent and Provider rows independently.
      value={`${section}::${model.label} ${model.id} ${model.provider} ${model.hint} ${model.description}`}
      onSelect={() => onPick(model.id)}
      className={cn("items-start", selected && "bg-primary/[0.07]")}
    >
      <ProviderIcon
        provider={model.provider}
        size={12}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[12px] font-medium">
            {model.label}
          </span>
          <span className="font-mono text-[10px] lowercase tracking-tight text-muted-foreground">
            {model.hint}
          </span>
        </div>
        <p className="truncate text-[10.5px] text-muted-foreground/80">
          {model.description}
        </p>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void toggleFavoriteModel(model.id);
        }}
        className={cn(
          "shrink-0 rounded p-1 hover:bg-foreground/[0.06]",
          favorite ? "text-amber-500" : "text-muted-foreground/40",
        )}
        title={favorite ? "Unfavorite" : "Favorite"}
      >
        <HugeiconsIcon
          icon={favorite ? StarIcon : StarHalfIcon}
          className="size-3"
        />
      </button>
    </CommandItem>
  );
});
