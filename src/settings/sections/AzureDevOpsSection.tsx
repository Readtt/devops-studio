import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AzureDevOpsBrand } from "@/components/AzureDevOpsBrand";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  emitAdoConnectionChanged,
  setCodeSearchEnabled,
} from "@/modules/settings/store";
import { cn } from "@/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  adoErrorMessage,
  getConnection,
  setConnection,
  testConnection,
  toAdoError,
  type AdoError,
  type ConnectionStatus,
} from "@/modules/ado";
import {
  CURRENT_BRANCH_SENTINEL,
  usePrimaryRepoGitInfo,
} from "@/modules/git";
import {
  CheckmarkCircle02Icon,
  GitBranchIcon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

type StatusBadge =
  | { kind: "unverified" }
  | { kind: "verifying" }
  | { kind: "verified"; identityName: string }
  | { kind: "bad-pat"; reason: string }
  | { kind: "sso-required" }
  | { kind: "network"; message: string }
  | { kind: "error"; message: string };

export function AzureDevOpsSection() {
  const [orgUrl, setOrgUrl] = useState("");
  const [project, setProject] = useState("");
  const [pat, setPat] = useState("");
  const [patVisible, setPatVisible] = useState(false);
  const [hasStoredPat, setHasStoredPat] = useState(false);
  const gitInfo = usePrimaryRepoGitInfo();
  const hasRepo = usePreferencesStore((s) => s.repos.length > 0);
  const codeSearchEnabled = usePreferencesStore((s) => s.codeSearchEnabled);
  const [status, setStatus] = useState<StatusBadge>({ kind: "unverified" });
  const [saving, setSaving] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Hydrate from backend on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getConnection();
        if (cancelled) return;
        applyStatus(s);
        if (s.configured) {
          await verify();
        }
      } catch {
        // First-run, nothing stored — leave defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyStatus(s: ConnectionStatus) {
    setOrgUrl(s.orgUrl);
    setProject(s.project);
    setHasStoredPat(s.hasPat);
  }

  async function verify(): Promise<boolean> {
    setStatus({ kind: "verifying" });
    try {
      const r = await testConnection();
      if (r.ok) {
        setStatus({
          kind: "verified",
          identityName: r.identityName ?? "",
        });
        return true;
      }
      mapErrorToStatus(r.error ?? { kind: "local", message: "Unknown error" });
      return false;
    } catch (e) {
      mapErrorToStatus(toAdoError(e));
      return false;
    }
  }

  function mapErrorToStatus(err: AdoError) {
    switch (err.kind) {
      case "bad-pat":
        setStatus({ kind: "bad-pat", reason: err.reason });
        break;
      case "sso-required":
        setStatus({ kind: "sso-required" });
        break;
      case "network":
        setStatus({ kind: "network", message: err.message });
        break;
      case "not-configured":
        setStatus({ kind: "unverified" });
        break;
      default:
        setStatus({ kind: "error", message: adoErrorMessage(err) });
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await setConnection({
        orgUrl,
        // Keep whatever project was set — the explorer header is the
        // canonical place to switch projects now.
        project,
        pat: pat.length > 0 ? pat : undefined,
        // Code-link branch is always the live source-dir branch, resolved at
        // publish time (the `$current` sentinel). There's no fixed-branch
        // option — links should follow the branch you generated from.
        defaultTrackingBranch: CURRENT_BRANCH_SENTINEL,
      });
      setPat("");
      // Tell the main window the connection changed so it re-reads + reloads
      // the Plans explorer immediately (this lives in a separate webview, so
      // the backend's in-memory state update doesn't reach it on its own).
      void emitAdoConnectionChanged();
      const ok = await verify();
      if (ok) {
        const s = await getConnection();
        applyStatus(s);
      }
    } catch (e) {
      mapErrorToStatus(toAdoError(e));
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    // Always push the current form to the backend before probing. Otherwise
    // editing the org URL without re-typing the PAT leaves the backend's
    // in-memory connection on the OLD org — and the probe happily reports
    // "Connected" against whatever the user typed last save.
    await onSave();
  }

  const canSave =
    orgUrl.trim().length > 0 &&
    (hasStoredPat || pat.trim().length > 0);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Azure DevOps"
        icon={<AzureDevOpsBrand size={16} />}
        description="Connect to your Azure DevOps organization to read Test Plans and publish generated cases. Switch projects from the explorer header."
      />

      <StatusBadgeRow
        status={status}
        project={project}
        onTest={onTest}
        canTest={canSave && !saving && status.kind !== "verifying"}
      />

      <div className="flex flex-col gap-2">
        <Label>Connection</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ado-org" className="text-[11.5px] text-muted-foreground">
              Organization URL
            </Label>
            <Input
              id="ado-org"
              placeholder="contoso  —  or  https://dev.azure.com/contoso"
              value={orgUrl}
              onChange={(e) => setOrgUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="h-8 text-[12px]"
            />
            <p className="text-[10.5px] text-muted-foreground/80">
              Paste the full URL or just the org slug. Legacy{" "}
              <code className="font-mono">{`{org}.visualstudio.com`}</code> URLs are auto-converted
              to <code className="font-mono">dev.azure.com</code> (cross-host redirects strip the
              PAT).
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Personal Access Token</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="ado-pat"
                className="text-[11.5px] text-muted-foreground"
              >
                PAT
              </Label>
              {hasStoredPat ? (
                <Badge
                  variant="outline"
                  className="h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    size={9}
                    strokeWidth={2}
                  />
                  Stored
                </Badge>
              ) : null}
            </div>
            <div className="relative">
              <Input
                id="ado-pat"
                type={patVisible ? "text" : "password"}
                placeholder={
                  hasStoredPat
                    ? "Leave blank to keep the stored token"
                    : "Paste your PAT here"
                }
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="h-8 pr-9 font-mono text-[12px]"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setPatVisible((v) => !v)}
                    aria-label={patVisible ? "Hide PAT" : "Show PAT"}
                    className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                  >
                    <HugeiconsIcon
                      icon={patVisible ? ViewOffSlashIcon : ViewIcon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[11px]">
                  {patVisible ? "Hide token" : "Show token"}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            className="self-start text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {helpOpen ? "Hide" : "How to"} create a PAT
          </button>
          {helpOpen ? <PatHelpBlock orgUrl={orgUrl} /> : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Defaults</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <Label className="text-[11.5px] text-foreground">
                Allow AI to read source code
              </Label>
              <p className="text-[10.5px] text-muted-foreground/80">
                {codeSearchEnabled
                  ? "Generator, Suite Chat, Code Review and Confidence may read your source directory (read-only) to ground their answers."
                  : "Off — every AI surface works from the spec / diff / case text alone, with no file access."}
              </p>
            </div>
            <Switch
              checked={codeSearchEnabled}
              onCheckedChange={(v) => void setCodeSearchEnabled(v)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={13}
                strokeWidth={1.75}
                aria-hidden
                className="text-muted-foreground"
              />
              <Label className="text-[11.5px] text-foreground">
                Code-link branch
              </Label>
            </div>
            <p className="text-[10.5px] text-muted-foreground/80">
              Code links on published cases point at the branch you generated
              from. It's read from your source directory at publish time, so
              links always follow the branch you're working on — switch branches
              in the status bar and the next publish tracks the new one.
            </p>
            <div className="mt-0.5 flex items-center gap-1.5 rounded-md border border-border/55 bg-muted/30 px-2 py-1.5 text-[10.5px]">
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                now
              </span>
              {gitInfo.isRepo && gitInfo.branch ? (
                <span className="text-foreground/85">
                  Links use{" "}
                  <span className="font-mono text-foreground">
                    {gitInfo.branch}
                  </span>
                  {gitInfo.commit ? (
                    <span className="text-muted-foreground/70">
                      {" · "}
                      {gitInfo.commit}
                    </span>
                  ) : null}
                  .
                </span>
              ) : gitInfo.isRepo ? (
                <span className="text-muted-foreground">
                  Detached HEAD — links fall back to{" "}
                  <span className="font-mono text-foreground/80">main</span>{" "}
                  until you check out a branch.
                </span>
              ) : hasRepo ? (
                <span className="text-muted-foreground">
                  Not a git repository — links fall back to{" "}
                  <span className="font-mono text-foreground/80">main</span>.
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Set a source directory to enable code links.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-border/40 pt-3">
        <Button
          onClick={onSave}
          disabled={saving || !canSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function StatusBadgeRow({
  status,
  project,
  onTest,
  canTest,
}: {
  status: StatusBadge;
  project: string;
  onTest: () => void;
  canTest: boolean;
}) {
  const map: Record<
    StatusBadge["kind"],
    { dot: string; label: string }
  > = {
    unverified: { dot: "bg-muted-foreground/40", label: "Not connected" },
    verifying: { dot: "bg-amber-400 animate-pulse", label: "Verifying…" },
    verified: { dot: "bg-emerald-500", label: "Connected" },
    "bad-pat": { dot: "bg-destructive", label: "PAT rejected" },
    "sso-required": {
      dot: "bg-orange-500",
      label: "PAT needs SSO authorization",
    },
    network: { dot: "bg-yellow-500", label: "Network error" },
    error: { dot: "bg-destructive", label: "Error" },
  };
  const meta = map[status.kind];
  let detail: string | null = null;
  if (status.kind === "verified") {
    const who = status.identityName ? `${status.identityName}` : null;
    const where = project ? `project ${project}` : null;
    if (who && where) detail = `${who} · ${where}`;
    else if (who) detail = who;
    else if (where) detail = where;
  } else if (status.kind === "bad-pat") detail = status.reason;
  else if (status.kind === "network") detail = status.message;
  else if (status.kind === "error") detail = status.message;
  else if (status.kind === "sso-required")
    detail =
      "Open the PAT page and click \"Authorize SSO\" next to the token.";
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-[12px]">
      <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", meta.dot)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{meta.label}</span>
        {detail ? (
          <span className="break-words text-[11px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onTest}
        disabled={!canTest}
        className="shrink-0"
      >
        {status.kind === "verifying" ? "Testing…" : "Test"}
      </Button>
    </div>
  );
}

function PatHelpBlock({ orgUrl }: { orgUrl: string }) {
  const tokensUrl =
    orgUrl.trim().length > 0
      ? `${orgUrl.replace(/\/$/, "")}/_usersSettings/tokens`
      : "https://dev.azure.com/{org}/_usersSettings/tokens";
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-[10.5px] text-muted-foreground">
      <div>
        Open{" "}
        <button
          type="button"
          onClick={() => void openUrl(tokensUrl)}
          className="break-all font-mono text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {tokensUrl}
        </button>{" "}
        and create a new token with these scopes:
      </div>
      <ul className="ml-1 flex flex-col gap-0.5">
        <ScopeRow label="Test Management" perms="Read & write" />
        <ScopeRow label="Work Items" perms="Read & write" />
        <ScopeRow label="Code" perms="Read" />
        <ScopeRow label="Identity" perms="Read" />
      </ul>
      <div>
        If your org enforces SSO, click <em>Authorize SSO</em> on the token
        after creating it.
      </div>
    </div>
  );
}

function ScopeRow({ label, perms }: { label: string; perms: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <HugeiconsIcon
        icon={Tick02Icon}
        size={10}
        strokeWidth={2}
        className="text-emerald-500"
      />
      <span className="text-foreground/85">{label}</span>
      <span>—</span>
      <span>{perms}</span>
    </li>
  );
}
