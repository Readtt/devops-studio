import { BrandIcon } from "@/components/BrandIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  cancelSetupClaudeToken,
  checkClaudeAuth,
  claudeErrorMessage,
  extractAuthUrl,
  probeClaude,
  setupClaudeToken,
  type AuthStatus,
  type ClaudeProbe,
} from "@/modules/ai/lib/claude";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setAiEngine,
  setClaudeAuthMode,
  type AiEngine,
  type ClaudeAuthMode,
} from "@/modules/settings/store";
import {
  CheckmarkCircle02Icon,
  ExternalLink,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Engine + auth picker. Shown at the top of the Models settings page.
 *
 * Two engines, both backed by the user's Claude Pro/Max sub or BYOK keys:
 *   - "claude-agent-sdk" — drives the installed `claude` CLI for full
 *     agent-loop behavior (Read/Glob/Grep/Bash tools, subagents, MCP).
 *   - "vercel-ai-sdk"    — Vercel AI SDK (works without `claude` installed),
 *     uses any provider key in the keyring (Anthropic / OpenAI / Google).
 */
export function AiEngineSection() {
  const engine = usePreferencesStore((s) => s.aiEngine);
  const authMode = usePreferencesStore((s) => s.claudeAuthMode);

  const [probe, setProbe] = useState<ClaudeProbe | null | undefined>(undefined);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupLines, setSetupLines] = useState<string[]>([]);
  const [setupAuthUrl, setSetupAuthUrl] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const setupOutputRef = useRef<HTMLPreElement | null>(null);

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const r = await probeClaude();
      setProbe(r);
      // Probe only tells us the binary is installed. Run auth status next so
      // the badge reflects "Authenticated" vs "Found but not logged in" — the
      // previous behavior showed "Found vX" for any installed CLI regardless
      // of whether the user had actually completed login.
      if (r) {
        try {
          const status = await checkClaudeAuth();
          setAuthStatus(status);
        } catch {
          setAuthStatus(null);
        }
      } else {
        setAuthStatus(null);
      }
    } catch (e) {
      setProbe(null);
      setAuthStatus(null);
      setProbeError(claudeErrorMessage(e));
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  const onConnectMax = useCallback(async () => {
    setSetupRunning(true);
    setSetupLines([]);
    setSetupAuthUrl(null);
    setSetupError(null);
    try {
      await setupClaudeToken((evt) => {
        setSetupLines((prev) => [...prev, evt.line]);
        const url = extractAuthUrl(evt.line);
        if (url) setSetupAuthUrl((curr) => curr ?? url);
        // Stick the log to the bottom.
        queueMicrotask(() => {
          const el = setupOutputRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      });
      await runProbe();
    } catch (e) {
      setSetupError(claudeErrorMessage(e));
    } finally {
      setSetupRunning(false);
    }
  }, [runProbe]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[13px] font-semibold">AI engine</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Which engine the Generator routes through. Both can grind through
          your source code for test-case generation; Claude Code adds the
          full Anthropic agent loop (Read / Glob / Grep / Bash) when you've
          got the CLI installed.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <EngineCard
          id="claude-agent-sdk"
          label="Claude Code"
          summary="Uses your installed `claude` CLI. Supports Max-subscription OAuth or Anthropic API key."
          active={engine === "claude-agent-sdk"}
          onPick={() => void setAiEngine("claude-agent-sdk")}
          icon={<BrandIcon name="anthropic" size={14} />}
        />
        <EngineCard
          id="vercel-ai-sdk"
          label="Vercel AI SDK (BYOK)"
          summary="Bring your own API key for Anthropic / OpenAI / Google. No CLI needed."
          active={engine === "vercel-ai-sdk"}
          onPick={() => void setAiEngine("vercel-ai-sdk")}
          icon={<BrandIcon name="vercel" size={14} />}
        />
      </div>

      {engine === "claude-agent-sdk" ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11.5px] text-muted-foreground">
              Claude Code CLI
            </Label>
            <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
              {probe === undefined || probing ? (
                <span className="text-muted-foreground">Detecting…</span>
              ) : probe && authStatus?.authenticated ? (
                <Badge
                  variant="outline"
                  className="h-5 gap-1 border-primary/50 bg-primary/10 px-2 text-[10.5px] font-normal text-primary"
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    size={10}
                    strokeWidth={2}
                  />
                  Authenticated · v{probe.version}
                </Badge>
              ) : probe ? (
                <Badge
                  variant="outline"
                  className="h-5 gap-1 border-amber-500/40 bg-amber-500/10 px-2 text-[10.5px] font-normal text-amber-700 dark:text-amber-300"
                >
                  Installed · not logged in
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="h-5 gap-1 border-amber-500/40 bg-amber-500/10 px-2 text-[10.5px] font-normal text-amber-700 dark:text-amber-300"
                >
                  Not found
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[10.5px]"
                onClick={() => void runProbe()}
                disabled={probing}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={11}
                  strokeWidth={1.75}
                  className={probing ? "animate-spin" : ""}
                />
                Detect again
              </Button>
              {probe ? (
                <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/80">
                  {probe.path}
                </span>
              ) : null}
            </div>
            {probeError ? (
              <p className="text-[10.5px] text-destructive">{probeError}</p>
            ) : null}
            {!probe && !probing ? (
              <p className="text-[10.5px] text-muted-foreground/85">
                Install Claude Code from{" "}
                <code className="font-mono">claude.ai/code</code>, then click
                Detect again.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[11.5px] text-muted-foreground">
              Authentication
            </Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <AuthCard
                id="max-oauth"
                label="Claude Max / Pro subscription"
                summary="Sign in once via Anthropic's device-code flow. The CLI stores the token."
                active={authMode === "max-oauth"}
                onPick={() => void setClaudeAuthMode("max-oauth")}
              />
              <AuthCard
                id="api-key"
                label="Anthropic API key"
                summary="Set via the provider card below. Passed to the CLI as ANTHROPIC_API_KEY."
                active={authMode === "api-key"}
                onPick={() => void setClaudeAuthMode("api-key")}
              />
            </div>

            {authMode === "max-oauth" ? (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 self-start px-2 text-[11px]"
                    disabled={!probe || setupRunning}
                    onClick={() => void onConnectMax()}
                  >
                    {setupRunning ? "Waiting for browser…" : "Connect Claude Max"}
                  </Button>
                  {setupAuthUrl ? (
                    <Button
                      size="sm"
                      className="h-7 self-start gap-1 px-2 text-[11px]"
                      onClick={() => void openUrl(setupAuthUrl)}
                    >
                      <HugeiconsIcon
                        icon={ExternalLink}
                        size={11}
                        strokeWidth={1.75}
                      />
                      Open in browser
                    </Button>
                  ) : null}
                  {setupRunning ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-[11px]"
                      onClick={async () => {
                        // Kill the stuck `claude auth login` child (callback
                        // may not have reached localhost in devcontainers /
                        // WSL / firewalled setups), then run `claude auth
                        // status` to see whether the credentials actually
                        // landed. Probing --version isn't enough — the binary
                        // always exists; auth status is the source of truth.
                        await cancelSetupClaudeToken();
                        await runProbe();
                      }}
                    >
                      <HugeiconsIcon
                        icon={RefreshIcon}
                        size={11}
                        strokeWidth={1.75}
                      />
                      I've authorized — recheck
                    </Button>
                  ) : null}
                </div>
                <p className="text-[10.5px] text-muted-foreground/85">
                  Runs <code className="font-mono">claude setup-token</code>. The
                  CLI prints a URL — click <em>Open in browser</em>, authorize,
                  and this panel will update when the CLI confirms the token.
                </p>
                {setupLines.length > 0 ? (
                  <pre
                    ref={setupOutputRef}
                    className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {setupLines.join("\n")}
                  </pre>
                ) : null}
                {setupError ? (
                  <p className="text-[10.5px] text-destructive">{setupError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EngineCard({
  id: _id,
  label,
  summary,
  active,
  onPick,
  icon,
}: {
  id: AiEngine;
  label: string;
  summary: string;
  active: boolean;
  onPick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex cursor-pointer flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors",
        active
          ? "border-primary/60 bg-primary/[0.06]"
          : "border-border/60 bg-card/60 hover:bg-foreground/[0.03]",
      )}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-medium">
        {icon}
        {label}
        {active ? (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={11}
            strokeWidth={2}
            className="text-primary"
          />
        ) : null}
      </span>
      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        {summary}
      </span>
    </button>
  );
}

function AuthCard({
  id: _id,
  label,
  summary,
  active,
  onPick,
}: {
  id: ClaudeAuthMode;
  label: string;
  summary: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-primary/60 bg-primary/[0.05]"
          : "border-border/60 bg-card/40 hover:bg-foreground/[0.03]",
      )}
    >
      <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
        {label}
        {active ? (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={10}
            strokeWidth={2}
            className="text-primary"
          />
        ) : null}
      </span>
      <span className="text-[10px] leading-relaxed text-muted-foreground">
        {summary}
      </span>
    </button>
  );
}
