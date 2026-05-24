import { Badge } from "@/components/ui/badge";
import { BranchPicker } from "@/components/BranchPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AzureDevOpsBrand } from "@/components/AzureDevOpsBrand";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
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
  useSourceDirGitInfo,
} from "@/modules/git";
import {
  CheckmarkCircle02Icon,
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
  const [trackingBranch, setTrackingBranch] = useState("main");
  const [useDynamicBranch, setUseDynamicBranch] = useState(false);
  const gitInfo = useSourceDirGitInfo();
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  // Branch list comes from the user's source repo — that's where their
  // working branches actually exist, and ADO mirrors them by name. Pulling
  // from git locally avoids a network round-trip to ADO for something the
  // user can already see on their disk. Falls back to common defaults if
  // no source dir is set.
  const [repoBranches, setRepoBranches] = useState<string[]>(["main", "master"]);
  useEffect(() => {
    if (!sourceRoot) {
      setRepoBranches(["main", "master"]);
      return;
    }
    let cancelled = false;
    void invoke<string[]>("git_branch_list", { cwd: sourceRoot })
      .then((list) => {
        if (cancelled) return;
        // Always include "main" / "master" as fallbacks so the user can
        // still pick those names if the repo doesn't have them yet (e.g.
        // brand-new repo without an initial commit on the canonical name).
        const merged = Array.from(new Set([...list, "main", "master"]));
        setRepoBranches(merged);
      })
      .catch(() => {
        if (!cancelled) setRepoBranches(["main", "master"]);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceRoot]);
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
    const saved = s.defaultTrackingBranch || "main";
    if (saved === CURRENT_BRANCH_SENTINEL) {
      setUseDynamicBranch(true);
      setTrackingBranch("main");
    } else {
      setUseDynamicBranch(false);
      setTrackingBranch(saved);
    }
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
        defaultPlanId: null,
        defaultTrackingBranch: useDynamicBranch
          ? CURRENT_BRANCH_SENTINEL
          : trackingBranch || "main",
      });
      setPat("");
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
              placeholder="macroagility  —  or  https://dev.azure.com/macroagility"
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
                Use current source-directory branch
              </Label>
              <p className="text-[10.5px] text-muted-foreground/80">
                {gitInfo.isRepo && gitInfo.branch
                  ? `On branch ${gitInfo.branch}${gitInfo.commit ? ` · ${gitInfo.commit}` : ""}.`
                  : gitInfo.isRepo
                    ? "Source directory is in detached HEAD — set a branch below as a fallback."
                    : "No git repo at the source directory yet — set a fallback below."}
              </p>
            </div>
            <Switch
              checked={useDynamicBranch}
              onCheckedChange={setUseDynamicBranch}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[11.5px] text-muted-foreground">
              {useDynamicBranch ? "Fallback branch" : "Tracking branch"}
            </Label>
            <BranchPicker
              value={trackingBranch}
              branches={repoBranches}
              onChange={setTrackingBranch}
              disabled={useDynamicBranch && gitInfo.isRepo && !!gitInfo.branch}
              size="md"
              ariaLabel={
                useDynamicBranch ? "Fallback branch" : "Tracking branch"
              }
            />
            <p className="text-[10.5px] text-muted-foreground/80">
              {useDynamicBranch
                ? "Used when the source directory has no resolvable branch (detached HEAD or not a git repo). Picker shows branches detected in your source repo."
                : sourceRoot
                  ? "Staleness scans watch this branch. The list is your source repo's actual branches — no typos possible."
                  : "Staleness scans watch this branch. Set a source directory to populate the picker from your repo."}
            </p>
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
        <span className="font-mono break-all text-foreground/80">
          {tokensUrl}
        </span>{" "}
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
