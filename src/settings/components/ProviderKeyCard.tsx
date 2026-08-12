import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ProviderInfo } from "@/modules/ai/config";
import {
  AlertCircleIcon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Edit02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { testProviderKey, type KeyTestResult } from "@/modules/ai/lib/testKey";

type Props = {
  provider: ProviderInfo;
  currentKey: string | null;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
  onRemove?: () => void;
};

function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}

export function ProviderKeyCard({
  provider,
  currentKey,
  onSave,
  onClear,
  onRemove,
}: Props) {
  const [editing, setEditing] = useState(!currentKey);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<KeyTestResult | null>(null);

  useEffect(() => {
    setEditing(!currentKey);
    setTestResult(null);
  }, [currentKey]);

  // Soft, NON-blocking nudge when the key doesn't match the provider's known
  // prefix. Deliberately not a save blocker: a provider can rotate its prefix
  // (Google did), and a prefix can't tell same-prefix providers apart (OpenAI
  // and DeepSeek both use "sk-"). The Test button is the real wrong-/revoked-
  // key catch.
  const prefixWarn =
    provider.keyPrefix &&
    value.trim() &&
    !value.trim().startsWith(provider.keyPrefix)
      ? `This doesn't look like a ${provider.label} key (they start with "${provider.keyPrefix}") — you can still save it.`
      : null;

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter your API key.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setValue("");
      setReveal(false);
      setTestResult(null);
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (candidate: string) => {
    const k = candidate.trim();
    if (!k) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProviderKey(provider.id, k));
    } catch (e) {
      setTestResult({
        ok: false,
        kind: "inconclusive",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {currentKey ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            Connected
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Get key
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
        {onRemove ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={onRemove}
            title="Remove provider"
            className="size-7 text-muted-foreground hover:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Input
                type={reveal ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  provider.keyPrefix
                    ? `${provider.keyPrefix}…`
                    : "Paste API key"
                }
                value={value}
                disabled={saving}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                  if (testResult) setTestResult(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === "Escape" && currentKey) {
                    setValue("");
                    setReveal(false);
                    setError(null);
                    setEditing(false);
                  }
                }}
                className="h-8 pr-7 font-mono text-[11.5px]"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                tabIndex={-1}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                aria-label={reveal ? "Hide key" : "Show key"}
              >
                <HugeiconsIcon
                  icon={reveal ? ViewOffSlashIcon : ViewIcon}
                  size={12}
                  strokeWidth={1.75}
                />
              </button>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runTest(value)}
                  disabled={testing || !value.trim()}
                  className="h-8 gap-1 px-2.5 text-[11px]"
                >
                  {testing ? <Spinner className="size-3" /> : null}
                  Test
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
                Fire one tiny request to confirm the key works before you rely
                on it — catches wrong-provider, revoked, and no-credit keys.
              </TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={saving || !value.trim()}
              className="h-8 gap-1 px-3 text-[11px]"
            >
              {saving ? <Spinner className="size-3" /> : null}
              Save
            </Button>
          </div>
          <KeyStatusLine
            error={error}
            prefixWarn={prefixWarn}
            testResult={testResult}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <code
              className={cn(
                "flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground",
              )}
            >
              {maskKey(currentKey ?? "")}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => currentKey && void runTest(currentKey)}
                  disabled={testing || !currentKey}
                  className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {testing ? <Spinner className="size-3" /> : null}
                  Test
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
                Check the saved key still works — revoked, out of credits, or
                for the wrong provider.
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                  aria-label="Replace key"
                  className="size-7"
                >
                  <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Replace this key
              </TooltipContent>
            </Tooltip>
            {!onRemove ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void onClear()}
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
            ) : null}
          </div>
          {testResult ? (
            <KeyStatusLine error={null} prefixWarn={null} testResult={testResult} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** One-line status under the key field: a save error, the live prefix warning,
 *  or the result of a "Test" probe — each with a matching tone + glyph.
 *  Shared with the local-provider cards so both Test buttons read identically. */
export function KeyStatusLine({
  error,
  prefixWarn,
  testResult,
}: {
  error: string | null;
  prefixWarn: string | null;
  testResult: KeyTestResult | null;
}) {
  if (error) {
    return <p className="text-[10.5px] text-destructive">{error}</p>;
  }
  if (testResult) {
    const tone = testResult.ok
      ? "text-emerald-600 dark:text-emerald-400"
      : testResult.kind === "inconclusive"
        ? "text-muted-foreground"
        : "text-destructive";
    return (
      <p className={cn("flex items-start gap-1 text-[10.5px]", tone)}>
        <HugeiconsIcon
          icon={testResult.ok ? CheckmarkCircle02Icon : AlertCircleIcon}
          size={11}
          strokeWidth={1.9}
          className="mt-px shrink-0"
        />
        <span>{testResult.message}</span>
      </p>
    );
  }
  if (prefixWarn) {
    return (
      <p className="flex items-start gap-1 text-[10.5px] text-amber-700 dark:text-amber-300">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={11}
          strokeWidth={1.75}
          className="mt-px shrink-0"
        />
        <span>{prefixWarn}</span>
      </p>
    );
  }
  return null;
}
