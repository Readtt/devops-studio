import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  MODELS,
  PROVIDERS,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
  type ProviderInfo,
} from "@/modules/ai/config";
import { clearKey, getAllKeys, setKey } from "@/modules/ai/lib/keyring";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  emitKeysChanged,
  onGenerationBusy,
  setDefaultModel,
  setLmstudioBaseURL,
  setLmstudioModelId,
  setMlxBaseURL,
  setMlxModelId,
  setOllamaBaseURL,
  setOllamaModelId,
  setOpenaiCompatibleBaseURL,
  setOpenaiCompatibleContextLimit,
  setOpenaiCompatibleModelId,
  type GenerationBusyState,
} from "@/modules/settings/store";
import { AiEngineSection } from "../components/AiEngineSection";
import { BestPracticesPanel } from "./BestPracticesSection";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Key01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";

type KeysMap = Record<ProviderId, string | null>;

const isLocalProvider = (id: ProviderId): boolean => !providerNeedsKey(id);

type LocalMeta = {
  urlPlaceholder: string;
  modelPlaceholder: string;
  description: string;
  modelHint: React.ReactNode;
};

const LOCAL_META: Partial<Record<ProviderId, LocalMeta>> = {
  lmstudio: {
    urlPlaceholder: "http://localhost:1234/v1",
    modelPlaceholder: "qwen2.5-coder-7b-instruct",
    description:
      "Run GGUF models via LM Studio's HTTP server (Developer tab → enable).",
    modelHint: (
      <>
        The model id loaded in LM Studio — see the server's{" "}
        <span className="font-mono">/v1/models</span> page.
      </>
    ),
  },
  mlx: {
    urlPlaceholder: "http://127.0.0.1:8080/v1",
    modelPlaceholder: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
    description:
      "Apple-silicon inference via mlx_lm.server (pip install mlx-lm).",
    modelHint: (
      <>The Hugging Face repo path you launched mlx_lm.server with.</>
    ),
  },
  ollama: {
    urlPlaceholder: "http://localhost:11434/v1",
    modelPlaceholder: "qwen2.5-coder:7b",
    description: "Local models via Ollama's built-in OpenAI-compatible API.",
    modelHint: <>The model name from `ollama list` / `ollama pull`.</>,
  },
  "openai-compatible": {
    urlPlaceholder: "https://api.example.com/v1",
    modelPlaceholder: "gpt-4o, qwen3-max, glm-4.6, …",
    description: "Any OpenAI-compatible endpoint — vLLM, Z.AI, Fireworks, etc.",
    modelHint: null,
  },
};

export function ModelsSection() {
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const [adding, setAdding] = useState<Set<ProviderId>>(new Set());

  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const engine = usePreferencesStore((s) => s.aiEngine);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const compatBaseURL = usePreferencesStore((s) => s.openaiCompatibleBaseURL);
  const compatModelId = usePreferencesStore((s) => s.openaiCompatibleModelId);
  const compatContextLimit = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
  );

  useEffect(() => {
    void getAllKeys().then(setKeys);
  }, []);

  const onSaveKey = async (provider: ProviderId, value: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
    await emitKeysChanged();
  };

  const onClearKey = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
    await emitKeysChanged();
  };

  const localConfig = (id: ProviderId): LocalConfig | null => {
    switch (id) {
      case "lmstudio":
        return {
          baseURL: lmstudioBaseURL,
          modelId: lmstudioModelId,
          setBaseURL: setLmstudioBaseURL,
          setModelId: setLmstudioModelId,
        };
      case "mlx":
        return {
          baseURL: mlxBaseURL,
          modelId: mlxModelId,
          setBaseURL: setMlxBaseURL,
          setModelId: setMlxModelId,
        };
      case "ollama":
        return {
          baseURL: ollamaBaseURL,
          modelId: ollamaModelId,
          setBaseURL: setOllamaBaseURL,
          setModelId: setOllamaModelId,
        };
      case "openai-compatible":
        return {
          baseURL: compatBaseURL,
          modelId: compatModelId,
          setBaseURL: setOpenaiCompatibleBaseURL,
          setModelId: setOpenaiCompatibleModelId,
          contextLimit: compatContextLimit,
          setContextLimit: setOpenaiCompatibleContextLimit,
        };
      default:
        return null;
    }
  };

  const isConfigured = (id: ProviderId): boolean => {
    if (!isLocalProvider(id)) return !!keys?.[id];
    const cfg = localConfig(id);
    if (!cfg) return false;
    if (id === "openai-compatible")
      return !!cfg.baseURL.trim() && !!cfg.modelId.trim();
    return !!cfg.modelId.trim();
  };

  if (!keys) {
    return <div className="text-[12px] text-muted-foreground">Loading…</div>;
  }

  const configuredIds = new Set(
    PROVIDERS.filter((p) => isConfigured(p.id)).map((p) => p.id),
  );
  const visibleIds = new Set<ProviderId>(configuredIds);
  for (const id of adding) visibleIds.add(id);
  const visibleProviders = PROVIDERS.filter((p) => visibleIds.has(p.id));
  const addableProviders = PROVIDERS.filter((p) => !visibleIds.has(p.id));

  const removeProvider = (id: ProviderId) => {
    if (isLocalProvider(id)) {
      const cfg = localConfig(id);
      if (cfg) {
        void cfg.setModelId("");
        if (id === "openai-compatible") void cfg.setBaseURL("");
      }
      if (id === "openai-compatible") void onClearKey(id);
    } else {
      void onClearKey(id);
    }
    setAdding((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addProvider = (id: ProviderId) => {
    setAdding((prev) => new Set(prev).add(id));
  };

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Models"
        description="Connect the providers you use. Keys live in your OS keychain and are used only by DevOps Studio."
      />

      <AiEngineSection />

      {/* One single default-model selector for the whole app — it adapts to
          the engine and to which providers are connected, so the picker is
          the only place the user ever has to think about "which model". */}
      <DefaultModelBlock defaultModel={defaultModel} engine={engine} />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>Providers</Label>
          <AddProviderMenu
            providers={addableProviders}
            onAdd={addProvider}
          />
        </div>

        {visibleProviders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center">
            <p className="text-[12px] text-muted-foreground">
              No providers connected yet.
            </p>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
              Click “Add provider” to connect a cloud or local model source.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleProviders.map((p) =>
              isLocalProvider(p.id) ? (
                <LocalProviderCard
                  key={p.id}
                  provider={p}
                  configured={configuredIds.has(p.id)}
                  config={localConfig(p.id)!}
                  meta={LOCAL_META[p.id]!}
                  compatKey={p.id === "openai-compatible" ? keys[p.id] : undefined}
                  onSaveKey={(v) => onSaveKey(p.id, v)}
                  onClearKey={() => onClearKey(p.id)}
                  onRemove={() => removeProvider(p.id)}
                />
              ) : (
                <ProviderKeyCard
                  key={p.id}
                  provider={p}
                  currentKey={keys[p.id]}
                  onSave={(v) => onSaveKey(p.id, v)}
                  onClear={() => onClearKey(p.id)}
                  onRemove={() => removeProvider(p.id)}
                />
              ),
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border/50 pt-6">
        <BestPracticesPanel />
      </div>
    </div>
  );
}

type LocalConfig = {
  baseURL: string;
  modelId: string;
  setBaseURL: (v: string) => Promise<void>;
  setModelId: (v: string) => Promise<void>;
  contextLimit?: number;
  setContextLimit?: (v: number) => Promise<void>;
};

function AddProviderMenu({
  providers,
  onAdd,
}: {
  providers: readonly ProviderInfo[];
  onAdd: (id: ProviderId) => void;
}) {
  const cloud = providers.filter((p) => !isLocalProvider(p.id));
  const local = providers.filter((p) => isLocalProvider(p.id));
  const disabled = providers.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className="h-7 gap-1.5 px-2.5 text-[11px]"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          Add provider
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-55 p-1">
        {cloud.length > 0 ? (
          <>
            <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
              Cloud
            </DropdownMenuLabel>
            {cloud.map((p) => (
              <ProviderMenuItem key={p.id} provider={p} onAdd={onAdd} />
            ))}
          </>
        ) : null}
        {local.length > 0 ? (
          <>
            <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
              Local & custom
            </DropdownMenuLabel>
            {local.map((p) => (
              <ProviderMenuItem key={p.id} provider={p} onAdd={onAdd} />
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderMenuItem({
  provider,
  onAdd,
}: {
  provider: ProviderInfo;
  onAdd: (id: ProviderId) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onAdd(provider.id)}
      className="flex items-center gap-2 text-[12px]"
    >
      <ProviderIcon provider={provider.id} size={13} />
      <span>{provider.label}</span>
    </DropdownMenuItem>
  );
}

/**
 * Single source-of-truth model picker. Adapts to the active engine:
 *   - Vercel AI SDK (BYOK): every model whose provider has a key (or whose
 *     local server is configured) is pickable.
 *   - Claude Code: Anthropic models only — the CLI can't drive others.
 *
 * The picker hides anything that isn't currently pickable, then surfaces a
 * "N locked — connect more providers" footer so users still see the choice
 * is there. Writes through to the persisted `defaultModelId`, which is
 * mirrored into the chat store so the status bar and generator agree.
 */
function DefaultModelBlock({
  defaultModel,
  engine,
}: {
  defaultModel: ModelId;
  engine: "vercel-ai-sdk" | "claude-agent-sdk";
}) {
  const availability = useModelAvailability();
  const current = getModel(defaultModel);
  const totalModels = MODELS.length;
  const lockedCount = totalModels - availability.available.size;
  // Subscribe to the main window's generation-busy broadcast so we lock the
  // picker mid-run / mid-draft, same as the status-bar picker does locally.
  // Without this the user could swap the default model mid-refine and the
  // already-in-flight call would still use the OLD model — confusing.
  const [busy, setBusy] = useState<GenerationBusyState>({
    busy: false,
    reason: "idle",
  });
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onGenerationBusy((state) => setBusy(state)).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);
  const lockReason =
    busy.reason === "running"
      ? "A generation is running — model swap takes effect on the next run."
      : busy.reason === "refining"
        ? "Refining a draft — the model is locked for this thread."
        : busy.reason === "in-draft"
          ? "A draft is open in the generator. Start a new session to switch models."
          : "";
  const engineHint =
    engine === "claude-agent-sdk"
      ? "Claude Code drives Anthropic models only. Pick the one the generator and chat should default to."
      : "Used by the test-case generator unless you override it for a single run. Only providers you've connected are pickable.";

  // When the active default isn't usable under the current configuration,
  // surface it inline rather than silently substituting at run time. The
  // generator's error surface still classifies this, but a settings-time
  // warning is far less surprising.
  const defaultUnavailable = !availability.isAvailable(defaultModel);
  const defaultReason = availability.reason(defaultModel);

  return (
    <div className="flex flex-col gap-2">
      <Label>Default model</Label>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <ModelPicker
          value={defaultModel}
          onChange={(id) => void setDefaultModel(id)}
          filter={availability.isAvailable}
          side="bottom"
          align="start"
          disabled={busy.busy}
          disabledReason={lockReason}
          emptyMessage={
            engine === "claude-agent-sdk" ? (
              <>
                Claude Code drives Anthropic models only. Authenticate the CLI
                above, then switch to the BYOK engine if you want OpenAI /
                Gemini / etc.
              </>
            ) : (
              <>
                No providers connected yet. Add one below — keys live in your
                OS keychain.
              </>
            )
          }
          footer={
            lockedCount > 0 ? (
              <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <HugeiconsIcon
                  icon={Key01Icon}
                  size={10}
                  strokeWidth={1.75}
                  className="opacity-70"
                />
                <span>
                  {lockedCount} model{lockedCount === 1 ? "" : "s"} hidden —
                  connect more providers below.
                </span>
              </div>
            ) : undefined
          }
          trigger={({ provider, disabled }) => (
            <span
              className={cn(
                "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-card px-3 text-[12px] transition-colors",
                disabled
                  ? "cursor-not-allowed border-border/40 opacity-60"
                  : "hover:border-primary/60",
                defaultUnavailable && !disabled
                  ? "border-amber-500/40 bg-amber-500/[0.04]"
                  : "border-border/60",
              )}
              title={disabled ? lockReason : undefined}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProviderIcon provider={provider} size={13} />
                <span className="truncate font-medium">{current.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/85">
                  · {current.hint.toLowerCase()}
                </span>
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="opacity-60"
              />
            </span>
          )}
        />
        {busy.busy ? (
          <p className="flex items-center gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/[0.05] px-2 py-1 text-[10.5px] text-amber-700 dark:text-amber-300">
            <span
              aria-hidden
              className="inline-block size-1.5 animate-pulse rounded-full bg-amber-500"
            />
            <span className="font-mono uppercase tracking-wider text-[9.5px]">
              locked
            </span>
            <span className="opacity-50">·</span>
            <span>{lockReason}</span>
          </p>
        ) : null}
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          {engineHint}
        </p>
        {defaultUnavailable ? (
          <p className="flex items-center gap-1.5 text-[10.5px] text-amber-700 dark:text-amber-300">
            <HugeiconsIcon
              icon={Key01Icon}
              size={10}
              strokeWidth={1.75}
            />
            <span>
              Current default isn't usable under the active engine —{" "}
              {defaultReason ?? "configure its provider"} or pick another above.
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LocalProviderCard({
  provider,
  configured,
  config,
  meta,
  compatKey,
  onSaveKey,
  onClearKey,
  onRemove,
}: {
  provider: ProviderInfo;
  configured: boolean;
  config: LocalConfig;
  meta: LocalMeta;
  compatKey?: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onRemove: () => void;
}) {
  const { baseURL, modelId, setBaseURL, setModelId, contextLimit, setContextLimit } =
    config;
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [contextDraft, setContextDraft] = useState(String(contextLimit ?? ""));
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setUrlDraft(baseURL), [baseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);
  useEffect(() => setContextDraft(String(contextLimit ?? "")), [contextLimit]);

  const supportsKey = provider.id === "openai-compatible";

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={9} strokeWidth={2} />
            Connected
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Docs
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onRemove}
              aria-label="Remove provider"
              className="size-7 text-muted-foreground hover:text-destructive"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Remove this provider
          </TooltipContent>
        </Tooltip>
      </div>

      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        {meta.description}
      </span>

      <div className="mt-0.5 flex flex-col gap-2.5">
        <FieldRow label="Base URL">
          <div className="flex flex-1 gap-1.5">
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const v = urlDraft.trim();
                if (v !== baseURL) void setBaseURL(v);
              }}
              placeholder={meta.urlPlaceholder}
              spellCheck={false}
              className="h-8 flex-1 font-mono text-[11.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void test()}
              disabled={!urlDraft.trim()}
              className="h-8 px-3 text-[11px]"
            >
              Test
            </Button>
          </div>
        </FieldRow>

        <FieldRow label="Model ID">
          <Input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => {
              const v = modelDraft.trim();
              if (v !== modelId) void setModelId(v);
            }}
            placeholder={meta.modelPlaceholder}
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
          />
        </FieldRow>

        {setContextLimit ? (
          <FieldRow label="Context">
            <div className="flex flex-1 items-center gap-1.5">
              <Input
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                onBlur={() => {
                  const v = parseInt(contextDraft);
                  if (Number.isFinite(v) && v >= 1000) void setContextLimit(v);
                  else setContextDraft(String(contextLimit ?? ""));
                }}
                placeholder="128000"
                spellCheck={false}
                className="h-8 w-28 font-mono text-[11.5px]"
              />
              <span className="text-[10.5px] text-muted-foreground">tokens</span>
            </div>
          </FieldRow>
        ) : null}

        {supportsKey ? (
          <FieldRow label="API key">
            {compatKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {`${compatKey.slice(0, 4)}${"•".repeat(8)}${compatKey.slice(-4)}`}
                </code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void onClearKey()}
                      aria-label="Remove key"
                      className="size-7 text-muted-foreground hover:text-destructive"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-[11px]">
                    Remove this key
                  </TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Optional — leave empty for unauthenticated endpoints"
                  spellCheck={false}
                  className="h-8 flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                  className="h-8 px-3 text-[11px]"
                >
                  Save
                </Button>
              </div>
            )}
          </FieldRow>
        ) : null}

        <StatusLine status={testStatus} />

        {!modelId.trim() && meta.modelHint ? (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {meta.modelHint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] tracking-tight text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

function StatusLine({
  status,
}: {
  status: "idle" | "testing" | "ok" | "fail";
}) {
  if (status === "idle") return null;
  if (status === "testing") {
    return (
      <span className="text-[10.5px] text-muted-foreground">Testing…</span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
        Reachable — server responded.
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-destructive/80">
      Could not reach the server.
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
