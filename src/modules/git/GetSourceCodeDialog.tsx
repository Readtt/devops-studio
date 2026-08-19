import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AzureDevOpsLogo } from "@/components/AzureDevOpsLogo";
import { BrandIcon } from "@/components/BrandIcon";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  getConnection,
  listRepos,
  type ConnectionStatus,
  type RepoRef,
} from "@/modules/ado";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircleIcon,
  ArrowReloadHorizontalIcon,
  CloudDownloadIcon,
  Copy01Icon,
  FolderOpenIcon,
  GitBranchIcon,
  Settings01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { checkGitInstalled, setGitPath, type CloneAuth, type GitInstalled } from "./cloneOps";
import { resolveCloneTargets, sanitizeDir, type CloneTarget } from "./cloneTargets";
import { useCloneProgress, type CloneJob } from "./cloneProgressStore";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceRoot: string | null;
};

type Mode = "ado" | "custom";

/** Split a path into its parent (works for both `/` and `\` separators). */
function parentOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx > 0 ? norm.slice(0, idx) : norm;
}

function basenameOf(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function dirFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return sanitizeDir(seg.replace(/\.git$/i, ""));
  } catch {
    return "";
  }
}

/** Join a parent path with a folder, matching the parent's separator style. */
function joinPath(parent: string, folder: string): string {
  const trimmed = parent.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${sep}${folder}`;
}

/**
 * "Get source code" wizard. Clones one or more repos onto the machine for QA
 * testers who can't manage git themselves. Primary path uses the stored Azure
 * DevOps PAT (multi-select — clone several repos into one parent folder);
 * secondary path clones any HTTPS URL with typed credentials. Shows install
 * guidance when git is missing. Every repo that clones successfully joins the
 * workspace — nothing has to be picked afterwards.
 */
export function GetSourceCodeDialog({ open, onOpenChange, sourceRoot }: Props) {
  const [git, setGit] = useState<GitInstalled | null>(null);
  const [gitChecking, setGitChecking] = useState(true);
  const [mode, setMode] = useState<Mode>("ado");

  // Shared destination.
  const [destParent, setDestParent] = useState<string>("");
  const [dirName, setDirName] = useState<string>("");

  // ADO.
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());

  // Custom.
  const [customUrl, setCustomUrl] = useState("");
  const [customUser, setCustomUser] = useState("");
  const [customPass, setCustomPass] = useState("");

  const cloning = useCloneProgress((s) => s.phase === "cloning");
  const startBatch = useCloneProgress((s) => s.startBatch);

  // Probe whether git is installed. The `.catch` matters: git_check_installed
  // can reject (a backend join failure) — without it the rejection is unhandled
  // AND gitChecking would never clear on that path, wedging the dialog on
  // skeletons. On failure fall back to "not found" so the guidance panel (with
  // Locate / Check-again) shows instead.
  const probeGit = useCallback(() => {
    setGitChecking(true);
    void checkGitInstalled()
      .then(setGit)
      .catch(() => setGit(null))
      .finally(() => setGitChecking(false));
  }, []);

  // Reset + probe when the wizard OPENS. Keyed on `open` only — NOT sourceRoot:
  // reacting to a source-dir change while the wizard is open would wipe the
  // user's in-progress selection / typed URL / destination. We read the current
  // sourceRoot once here to seed the default destination and don't re-run on it.
  useEffect(() => {
    if (!open) return;
    setMode("ado");
    setSelectedRepoIds(new Set());
    setReposError(null);
    setRepos(null);
    setCustomUrl("");
    setCustomUser("");
    setCustomPass("");
    setDestParent(sourceRoot ? parentOf(sourceRoot) : "");
    setDirName("");

    probeGit();
    void getConnection()
      .then(setConn)
      .catch(() => setConn(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-only reset by design (see comment)
  }, [open, probeGit]);

  const gitReady = !!git?.installed;
  const adoReady = !!conn?.configured && !!conn?.hasPat;

  // Load repos when the ADO tab is usable.
  useEffect(() => {
    if (!open || !gitReady || mode !== "ado" || !adoReady || repos !== null) return;
    setReposError(null);
    void listRepos()
      .then((list) => setRepos([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => {
        setRepos([]);
        setReposError(e instanceof Error ? e.message : "Couldn't load repositories.");
      });
  }, [open, gitReady, mode, adoReady, repos]);

  // Selected repos in list order (so the preview reads top-to-bottom).
  const selectedRepos = useMemo(
    () => (repos ?? []).filter((r) => selectedRepoIds.has(r.id)),
    [repos, selectedRepoIds],
  );

  // Collision-free target folders for the multi-clone preview + jobs.
  const targets = useMemo(
    () =>
      resolveCloneTargets(
        selectedRepos.map((r) => ({ id: r.id, name: r.name, project: r.project ?? null })),
      ),
    [selectedRepos],
  );

  const toggleRepo = (repo: RepoRef) => {
    const next = new Set(selectedRepoIds);
    if (next.has(repo.id)) next.delete(repo.id);
    else next.add(repo.id);
    setSelectedRepoIds(next);
    // Keep the single-folder field meaningful when exactly one remains.
    if (next.size === 1) {
      const only = (repos ?? []).find((r) => next.has(r.id));
      if (only) setDirName(sanitizeDir(only.name));
    }
  };

  const chooseDest = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose where to put the code",
      defaultPath: destParent || undefined,
    });
    if (typeof picked === "string" && picked.length > 0) setDestParent(picked);
  };

  const locateGit = async () => {
    const picked = await openDialog({
      directory: false,
      multiple: false,
      title: "Locate the git executable",
    });
    if (typeof picked === "string" && picked.length > 0) {
      setGitChecking(true);
      try {
        setGit(await setGitPath(picked));
      } catch {
        // git_set_path can reject (e.g. the settings store save fails). Keep
        // whatever we knew about git rather than wedging — the user can retry
        // via "Check again" — and never leak an unhandled rejection.
      } finally {
        setGitChecking(false);
      }
    }
  };

  // Single-clone destination preview — uses the SAME sanitized folder the clone
  // will create, so what's shown is what's adopted as the source dir.
  const singleFolder = sanitizeDir(dirName);
  const finalPath = destParent && singleFolder ? joinPath(destParent, singleFolder) : "";

  const adoUrl = (repo: RepoRef): string => {
    if (repo.remoteUrl) return repo.remoteUrl;
    // Fallback: synthesize from the repo's OWN project — repos span the org now,
    // so the connection's project would build a URL for the wrong project (and
    // clone the wrong repo, or fail "not found"). No project ⇒ an obviously
    // broken URL that fails clearly, never a silently-wrong one.
    const org = (conn?.orgUrl ?? "").replace(/\/+$/, "");
    const project = encodeURIComponent(repo.project ?? "");
    return `${org}/${project}/_git/${encodeURIComponent(repo.name)}`;
  };

  const startBatchAndClose = (jobs: CloneJob[]) => {
    if (jobs.length === 0 || !destParent) return;
    void startBatch({ jobs, destParent });
    onOpenChange(false);
  };

  const adoJob = (repo: RepoRef, folder: string): CloneJob => ({
    url: adoUrl(repo),
    dirName: folder,
    auth: { kind: "adoPat" },
    // Always remember credentials so later branch switches / pulls just work.
    persistAuth: true,
    repoLabel: repo.name,
    project: repo.project ?? null,
  });

  const cloneAdo = () => {
    if (selectedRepos.length === 0 || !destParent) return;
    const jobs =
      selectedRepos.length === 1
        ? // Single: honor the editable folder name (fall back to the repo name).
          [adoJob(selectedRepos[0], singleFolder || sanitizeDir(selectedRepos[0].name) || "repo")]
        : targets.map((t) => {
            const repo = selectedRepos.find((r) => r.id === t.id)!;
            return adoJob(repo, t.folder);
          });
    startBatchAndClose(jobs);
  };

  const trimmedUrl = customUrl.trim();
  const looksSsh = /^git@|^ssh:\/\//i.test(trimmedUrl);
  const customValid = trimmedUrl.length > 0 && !looksSsh && !!finalPath;
  const cloneCustom = () => {
    if (!customValid) return;
    const u = customUser.trim();
    const auth: CloneAuth =
      customPass || u
        ? { kind: "basic", username: u || "token", password: customPass }
        : { kind: "none" };
    startBatchAndClose([
      {
        url: trimmedUrl,
        dirName: singleFolder || dirFromUrl(trimmedUrl) || "repo",
        auth,
        persistAuth: true,
        repoLabel: dirName || basenameOf(trimmedUrl),
        project: null,
      },
    ]);
  };

  const adoMulti = mode === "ado" && selectedRepos.length >= 2;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={CloudDownloadIcon}
              size={13}
              strokeWidth={1.75}
              className="text-primary"
            />
            Get source code
          </DialogTitle>
          <DialogDescription>
            Clone one or more repositories onto this machine so code links and
            grounded AI reviews work. You choose which becomes your source
            directory once it lands.
          </DialogDescription>
        </DialogHeader>

        {gitChecking ? (
          <div className="flex flex-col gap-2 py-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !gitReady ? (
          <GitGuidancePanel
            git={git}
            onRecheck={probeGit}
            onLocate={() => void locateGit()}
          />
        ) : (
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="ado" className="gap-1.5">
                <AzureDevOpsLogo className="size-3" mono />
                Azure DevOps
              </TabsTrigger>
              <TabsTrigger value="custom" className="gap-1.5">
                <BrandIcon name="git" className="size-3" branded={false} />
                Other repository
              </TabsTrigger>
            </TabsList>

            {/* ── Azure DevOps ── */}
            <TabsContent value="ado" className="flex flex-col gap-2.5 pt-1">
              {!adoReady ? (
                <div className="flex flex-col items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-3 text-[12px]">
                  <p className="text-muted-foreground">
                    Azure DevOps isn&apos;t connected yet. Add your organization
                    and PAT in Settings, then come back to pick repos.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void openSettingsWindow("azure-devops")}
                  >
                    <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
                    Open Settings
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <div className="flex h-4 items-center justify-between">
                      <Label className="text-[11px] text-muted-foreground">
                        Repositories
                      </Label>
                      {selectedRepos.length > 0 ? (
                        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                          <span className="tabular-nums">
                            {selectedRepos.length} selected
                          </span>
                          <button
                            type="button"
                            onClick={() => setSelectedRepoIds(new Set())}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            Clear
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <Command className="rounded-md border border-border/60">
                      <CommandInput placeholder="Search repositories…" />
                      <CommandList className="max-h-[200px]">
                        {repos === null ? (
                          <div className="flex flex-col gap-1 p-1.5">
                            <Skeleton className="h-7 w-full" />
                            <Skeleton className="h-7 w-full" />
                            <Skeleton className="h-7 w-2/3" />
                          </div>
                        ) : (
                          <>
                            <CommandEmpty>
                              {reposError ?? "No repositories match."}
                            </CommandEmpty>
                            <CommandGroup>
                              {repos.map((repo) => {
                                const selected = selectedRepoIds.has(repo.id);
                                return (
                                  <CommandItem
                                    key={repo.id}
                                    // Include the project so search matches either,
                                    // and same-named repos across projects stay distinct.
                                    value={`${repo.name} ${repo.project ?? ""}`}
                                    onSelect={() => toggleRepo(repo)}
                                  >
                                    <HugeiconsIcon
                                      icon={GitBranchIcon}
                                      size={12}
                                      strokeWidth={1.75}
                                      className="shrink-0 text-muted-foreground"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-[12px]">
                                      {repo.name}
                                    </span>
                                    {repo.project ? (
                                      <span className="max-w-[42%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                                        {repo.project}
                                      </span>
                                    ) : null}
                                    {/* Membership check: always present (opacity, not
                                        `hidden`) so toggling a repo doesn't reflow the
                                        row — it fades in place. */}
                                    <HugeiconsIcon
                                      icon={Tick02Icon}
                                      size={13}
                                      strokeWidth={2.5}
                                      className={cn(
                                        "shrink-0 text-primary transition-opacity",
                                        selected ? "opacity-100" : "opacity-0",
                                      )}
                                    />
                                  </CommandItem>
                                );
                              })}
                            </CommandGroup>
                          </>
                        )}
                      </CommandList>
                    </Command>
                  </div>

                  {adoMulti ? (
                    <MultiDestination
                      destParent={destParent}
                      targets={targets}
                      onChooseDest={() => void chooseDest()}
                    />
                  ) : (
                    <DestinationRow
                      label="Where to put it"
                      destParent={destParent}
                      dirName={dirName}
                      finalPath={finalPath}
                      placeholder={
                        selectedRepos.length === 0
                          ? "Select a repository above."
                          : "Pick a folder to clone into."
                      }
                      onChooseDest={() => void chooseDest()}
                      onDirNameChange={setDirName}
                    />
                  )}
                </>
              )}
            </TabsContent>

            {/* ── Other repository ── */}
            <TabsContent value="custom" className="flex flex-col gap-2.5 pt-1">
              <div className="flex flex-col gap-1">
                <Label htmlFor="clone-url" className="text-[11px] text-muted-foreground">
                  Repository URL (HTTPS)
                </Label>
                <Input
                  id="clone-url"
                  value={customUrl}
                  onChange={(e) => {
                    setCustomUrl(e.target.value);
                    const d = dirFromUrl(e.target.value.trim());
                    if (d) setDirName(d);
                  }}
                  placeholder="https://github.com/org/repo.git"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-[12px]"
                />
                {looksSsh ? (
                  <p className="text-[10.5px] text-destructive">
                    SSH URLs aren&apos;t supported — use the HTTPS URL instead.
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="clone-user" className="text-[11px] text-muted-foreground">
                    Username <span className="text-muted-foreground/60">(optional)</span>
                  </Label>
                  <Input
                    id="clone-user"
                    value={customUser}
                    onChange={(e) => setCustomUser(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="clone-pass" className="text-[11px] text-muted-foreground">
                    Password / token <span className="text-muted-foreground/60">(optional)</span>
                  </Label>
                  <Input
                    id="clone-pass"
                    type="password"
                    value={customPass}
                    onChange={(e) => setCustomPass(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>

              <DestinationRow
                label="Where to put it"
                destParent={destParent}
                dirName={dirName}
                finalPath={finalPath}
                placeholder="Pick a folder to clone into."
                onChooseDest={() => void chooseDest()}
                onDirNameChange={setDirName}
              />
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="mt-1 gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {gitReady ? "Cancel" : "Close"}
          </Button>
          {gitReady ? (
            mode === "ado" ? (
              <Button
                type="button"
                size="sm"
                disabled={!adoReady || selectedRepos.length === 0 || !destParent || cloning}
                onClick={cloneAdo}
              >
                <HugeiconsIcon icon={CloudDownloadIcon} size={12} strokeWidth={1.75} />
                {selectedRepos.length > 1 ? `Clone ${selectedRepos.length} repos` : "Clone"}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!customValid || cloning}
                onClick={cloneCustom}
              >
                <HugeiconsIcon icon={CloudDownloadIcon} size={12} strokeWidth={1.75} />
                Clone
              </Button>
            )
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function DestinationRow({
  label,
  destParent,
  dirName,
  finalPath,
  placeholder,
  onChooseDest,
  onDirNameChange,
}: {
  label: string;
  destParent: string;
  dirName: string;
  finalPath: string;
  placeholder: string;
  onChooseDest: () => void;
  onDirNameChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onChooseDest}
          className="shrink-0"
        >
          <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} />
          {destParent ? "Change…" : "Choose folder…"}
        </Button>
        <Input
          value={dirName}
          onChange={(e) => onDirNameChange(e.target.value)}
          placeholder="folder-name"
          autoComplete="off"
          spellCheck={false}
          className="h-8 font-mono text-[12px]"
        />
      </div>
      <p className="min-h-[14px] truncate font-mono text-[10.5px] text-muted-foreground/70">
        {finalPath || (destParent ? "" : placeholder)}
      </p>
    </div>
  );
}

/** Destination for a multi-repo clone: one parent folder, one subfolder per
 *  repo, shown as a preview so disambiguated names are never a surprise. */
function MultiDestination({
  destParent,
  targets,
  onChooseDest,
}: {
  destParent: string;
  targets: CloneTarget[];
  onChooseDest: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] text-muted-foreground">Where to put them</Label>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onChooseDest}
          className="shrink-0"
        >
          <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} />
          {destParent ? "Change…" : "Choose folder…"}
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
          {destParent || "Pick a parent folder — each repo gets its own."}
        </span>
      </div>
      <div className="max-h-[132px] overflow-y-auto rounded-md border border-border/50 bg-muted/20 p-1">
        {targets.map((t) => {
          const renamed = t.folder !== sanitizeDir(t.name);
          return (
            <div
              key={t.id}
              className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px]"
            >
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground/70"
              />
              <span className="min-w-0 flex-1 truncate text-foreground/90">{t.name}</span>
              <span aria-hidden className="shrink-0 text-muted-foreground/40">
                →
              </span>
              <span
                className={cn(
                  "shrink-0 max-w-[45%] truncate font-mono text-[10.5px]",
                  renamed ? "text-primary/90" : "text-muted-foreground",
                )}
                title={renamed ? "Renamed so it doesn't clash with another repo" : undefined}
              >
                {t.folder}
              </span>
            </div>
          );
        })}
      </div>
      <p className="min-h-[14px] text-[10.5px] text-muted-foreground/70">
        {targets.length} repositories, each in its own folder.
      </p>
    </div>
  );
}

function GitGuidancePanel({
  git,
  onRecheck,
  onLocate,
}: {
  git: GitInstalled | null;
  onRecheck: () => void;
  onLocate: () => void;
}) {
  const brokenMac = !!git?.presentButBroken && IS_MAC;
  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-amber-500"
        />
        <div className="text-[12px] leading-relaxed">
          <p className="font-medium text-foreground">Git isn&apos;t installed</p>
          <p className="text-muted-foreground">
            {brokenMac
              ? "The macOS Command Line Tools (which include git) aren't installed yet."
              : "DevOps Studio needs the git command-line tool to clone repositories. Install it, then check again."}
          </p>
        </div>
      </div>

      {IS_WINDOWS ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            Run this in a terminal, or download the installer:
          </p>
          <CopyCommand command="winget install --id Git.Git -e --source winget" />
          <ExternalLink
            href="https://git-scm.com/download/win"
            label="Download Git for Windows"
          />
        </div>
      ) : IS_MAC ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            Run this — it opens Apple&apos;s installer (no Terminal expertise needed):
          </p>
          <CopyCommand command="xcode-select --install" />
          <p className="text-[10.5px] text-muted-foreground/70">
            Or, if you use Homebrew: <span className="font-mono">brew install git</span>
          </p>
        </div>
      ) : IS_LINUX ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            Install git with your package manager:
          </p>
          <CopyCommand command="sudo apt install git" />
          <p className="text-[10.5px] text-muted-foreground/70">
            Fedora <span className="font-mono">sudo dnf install git</span> · Arch{" "}
            <span className="font-mono">sudo pacman -S git</span> · openSUSE{" "}
            <span className="font-mono">sudo zypper install git</span>
          </p>
          <ExternalLink href="https://git-scm.com/install/linux" label="Install guide" />
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" onClick={onRecheck}>
          <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={12} strokeWidth={1.75} />
          Check again
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onLocate}>
          Locate git…
        </Button>
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
        If you just installed git and it still isn&apos;t found, restart DevOps
        Studio so it picks up the new location.
      </p>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
        {command}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(command).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Copy command"
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={12}
              strokeWidth={2}
              className={cn(copied && "text-primary")}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">
          {copied ? "Copied" : "Copy"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(href)}
      className="w-fit text-[11px] text-primary underline-offset-2 hover:underline"
    >
      {label}
    </button>
  );
}
