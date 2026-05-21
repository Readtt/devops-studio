import { useMemo, useState } from "react";
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
import { MODELS, PROVIDERS, getModel, type ModelId } from "@/modules/ai/config";
import { ProviderIcon } from "./ProviderIcon";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  pushRecentModel,
  toggleFavoriteModel,
} from "@/modules/ai/lib/modelPrefs";
import { StarIcon, StarHalfIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type ModelPickerFilter = (modelId: ModelId) => boolean;

type Props = {
  value: ModelId;
  onChange: (id: ModelId) => void;
  /** Optional restriction (e.g. "anthropic-only" for the Claude engine
   *  selector in settings). When provided, models that fail the predicate
   *  are hidden entirely instead of disabled. */
  filter?: ModelPickerFilter;
  /** Disable the trigger and prevent opening the popover. Use when a run
   *  is mid-flight so the user can't swap models in-place. */
  disabled?: boolean;
  /** Tooltip-quality reason text shown to disabled triggers via title. */
  disabledReason?: string;
  /** Render slot for the trigger button. Receives the resolved model label
   *  so callers can decide how compact to render it (e.g. a status-bar
   *  pill vs. a wide generator-page button). */
  trigger: (state: {
    label: string;
    provider: (typeof PROVIDERS)[number]["id"];
    disabled: boolean;
  }) => React.ReactNode;
  /** Popover alignment — defaults to "end" (right-anchored for status-bar use). */
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
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
}: Props) {
  const [open, setOpen] = useState(false);
  const recents = usePreferencesStore((s) => s.recentModelIds);
  const favorites = usePreferencesStore((s) => s.favoriteModelIds);
  const current = getModel(value);

  const visibleModels = useMemo(() => {
    return MODELS.filter((m) => (filter ? filter(m.id as ModelId) : true));
  }, [filter]);

  const grouped = useMemo(() => {
    // Build provider → models map preserving the registry order so the
    // popover lists providers in a consistent, intentional sequence.
    const byProvider = new Map<string, typeof MODELS[number][]>();
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
    .filter((m): m is (typeof MODELS)[number] => Boolean(m));

  const favoriteVisible = favorites
    .map((id) => visibleModels.find((m) => m.id === id))
    .filter((m): m is (typeof MODELS)[number] => Boolean(m));

  const onPick = (id: string) => {
    setOpen(false);
    onChange(id as ModelId);
    void pushRecentModel(id);
  };

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
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
        className="w-[320px] p-0"
      >
        <Command>
          <CommandInput placeholder="Search models…" className="text-[12px]" />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No models match.</CommandEmpty>
            {recentVisible.length > 0 ? (
              <>
                <CommandGroup heading="Recent">
                  {recentVisible.map((m) => (
                    <ModelRow
                      key={`recent-${m.id}`}
                      model={m}
                      selected={m.id === value}
                      favorite={favorites.includes(m.id)}
                      onPick={() => onPick(m.id)}
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
                      model={m}
                      selected={m.id === value}
                      favorite
                      onPick={() => onPick(m.id)}
                    />
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {grouped.map((g) => (
              <CommandGroup key={g.provider.id} heading={g.provider.label}>
                {g.models.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={m.id === value}
                    favorite={favorites.includes(m.id)}
                    onPick={() => onPick(m.id)}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  model,
  selected,
  favorite,
  onPick,
}: {
  model: (typeof MODELS)[number];
  selected: boolean;
  favorite: boolean;
  onPick: () => void;
}) {
  return (
    <CommandItem
      // The CommandList filters by `value` text — concat the bits we want
      // matchable so typing "sonnet" or "anthropic" both surface the model.
      value={`${model.label} ${model.id} ${model.provider} ${model.hint} ${model.description}`}
      onSelect={onPick}
      className={cn(
        "flex items-start gap-2 py-1.5",
        selected && "bg-primary/[0.07]",
      )}
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
          // Don't trigger row selection when toggling favorite.
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
}
