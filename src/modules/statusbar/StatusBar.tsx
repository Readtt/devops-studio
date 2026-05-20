import { useChatStore } from "@/modules/ai";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import {
  AiOpenButton,
  AiStatusBarControls,
} from "@/modules/ai/components/AiStatusBarControls";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getConnection } from "@/modules/ado";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useStaleCases } from "@/modules/test-plans";
import { AlertCircleIcon, CloudServerIcon, IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";
import type { WorkspaceEnv } from "@/modules/workspace";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
  onOpenStaleQueue?: () => void;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenMini,
  hasComposer,
  privateActive,
  onOpenStaleQueue,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const openPanel = useChatStore((s) => s.openPanel);
  const staleCount = useStaleCases((s) => s.cases.length);
  const [adoConfigured, setAdoConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const c = await getConnection();
        if (!cancelled) setAdoConfigured(c.configured);
      } catch {
        if (!cancelled) setAdoConfigured(false);
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private: hidden from AI</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-[11px] leading-relaxed">
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void openSettingsWindow("azure-devops")}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[11px] transition-colors",
                adoConfigured
                  ? "border-border/60 bg-card text-muted-foreground hover:text-foreground"
                  : "border-border/60 bg-card text-muted-foreground/70 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  adoConfigured ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              <HugeiconsIcon
                icon={CloudServerIcon}
                size={11}
                strokeWidth={1.75}
              />
              <span>ADO</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            {adoConfigured
              ? "Connected to Azure DevOps. Click to open settings."
              : "Not connected. Click to configure."}
          </TooltipContent>
        </Tooltip>
        {staleCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onOpenStaleQueue?.()}
                className="flex h-6 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
              >
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  size={11}
                  strokeWidth={1.75}
                />
                <span>Stale: {staleCount}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              {staleCount} test case{staleCount === 1 ? "" : "s"} need review —
              click to open the Stale queue.
            </TooltipContent>
          </Tooltip>
        ) : null}
        <AgentStatusPill onClick={onOpenMini} />
        {panelOpen && hasComposer ? (
          <AiStatusBarControls />
        ) : (
          <AiOpenButton onOpen={openPanel} />
        )}
      </div>
    </footer>
  );
}
