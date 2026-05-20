import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  adoErrorMessage,
  getConnection,
  listPlans,
  setConnection,
  testConnection,
  toAdoError,
  type AdoError,
  type ConnectionStatus,
  type TestPlanRef,
} from "@/modules/ado";
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
  const [defaultPlanId, setDefaultPlanId] = useState<number | null>(null);
  const [trackingBranch, setTrackingBranch] = useState("main");
  const [plans, setPlans] = useState<TestPlanRef[]>([]);
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
    setDefaultPlanId(s.defaultPlanId ?? null);
    setTrackingBranch(s.defaultTrackingBranch || "main");
  }

  async function verify(): Promise<boolean> {
    setStatus({ kind: "verifying" });
    try {
      const r = await testConnection();
      if (r.ok) {
        setStatus({
          kind: "verified",
          identityName: r.identityName ?? "Unknown user",
        });
        await refreshPlans();
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

  async function refreshPlans() {
    try {
      const list = await listPlans();
      setPlans(list);
    } catch {
      setPlans([]);
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await setConnection({
        orgUrl,
        project,
        pat: pat.length > 0 ? pat : undefined,
        defaultPlanId,
        defaultTrackingBranch: trackingBranch || "main",
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
    if (pat.length > 0) {
      // Persist the just-typed PAT first, then verify.
      await onSave();
    } else {
      await verify();
    }
  }

  const canSave =
    orgUrl.trim().length > 0 &&
    project.trim().length > 0 &&
    (hasStoredPat || pat.trim().length > 0);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Azure DevOps"
        description="Connect to your Azure DevOps organization to read Test Plans and publish generated cases."
      />

      <StatusBadgeRow status={status} />

      <div className="flex flex-col gap-2">
        <Label>Connection</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ado-org" className="text-[11.5px] text-muted-foreground">
              Organization URL
            </Label>
            <Input
              id="ado-org"
              placeholder="https://dev.azure.com/your-org"
              value={orgUrl}
              onChange={(e) => setOrgUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="h-8 text-[12px]"
            />
            <p className="text-[10.5px] text-muted-foreground/80">
              Also accepts <code className="font-mono">{`{org}.visualstudio.com`}</code>. Missing
              scheme gets <code className="font-mono">https://</code> prepended.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="ado-project"
              className="text-[11.5px] text-muted-foreground"
            >
              Project
            </Label>
            <Input
              id="ado-project"
              placeholder="MyProduct"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="h-8 text-[12px]"
            />
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
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="ado-plan"
              className="text-[11.5px] text-muted-foreground"
            >
              Default Test Plan
            </Label>
            <Select
              value={defaultPlanId !== null ? String(defaultPlanId) : ""}
              onValueChange={(v) =>
                setDefaultPlanId(v === "" ? null : Number(v))
              }
            >
              <SelectTrigger id="ado-plan" className="h-8 w-full text-[12px]">
                <SelectValue
                  placeholder={
                    status.kind === "verified"
                      ? plans.length === 0
                        ? "No plans found"
                        : "Choose a plan"
                      : "Connect first to populate"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="ado-branch"
              className="text-[11.5px] text-muted-foreground"
            >
              Tracking branch
            </Label>
            <Input
              id="ado-branch"
              value={trackingBranch}
              onChange={(e) => setTrackingBranch(e.target.value)}
              placeholder="main"
              spellCheck={false}
              autoComplete="off"
              className="h-8 font-mono text-[12px]"
            />
            <p className="text-[10.5px] text-muted-foreground/80">
              Staleness scans watch this branch for commits to linked files.
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-border/40 pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={saving || status.kind === "verifying" || !canSave}
        >
          {status.kind === "verifying" ? "Testing…" : "Test connection"}
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving || !canSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function StatusBadgeRow({ status }: { status: StatusBadge }) {
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
  if (status.kind === "verified") detail = `as ${status.identityName}`;
  else if (status.kind === "bad-pat") detail = status.reason;
  else if (status.kind === "network") detail = status.message;
  else if (status.kind === "error") detail = status.message;
  else if (status.kind === "sso-required")
    detail =
      "Open the PAT page and click \"Authorize SSO\" next to the token.";
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-[12px]">
      <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", meta.dot)} />
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{meta.label}</span>
        {detail ? (
          <span className="break-words text-[11px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </div>
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
