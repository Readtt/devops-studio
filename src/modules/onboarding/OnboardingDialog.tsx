import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CheckmarkCircle02Icon,
  PlayIcon,
  AiBrain01Icon,
  PlugSocketIcon,
  FolderOpenIcon,
  ArrowRight02Icon,
  ArrowLeft02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  setConnection,
  testConnection,
  type AdoError,
  type TestConnectionResult,
} from "@/modules/ado";
import { setKey } from "@/modules/ai/lib/keyring";
import {
  setOnboardingComplete,
  setSourceRoot,
} from "@/modules/settings/store";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { getModel, getProvider } from "@/modules/ai/config";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AzureDevOpsLogo } from "@/components/AzureDevOpsLogo";
import { adoErrorMessage } from "@/modules/ado";

type Props = {
  open: boolean;
  onClose: () => void;
};

type Step = "welcome" | "ado" | "ai" | "source" | "done";

const STEPS: Step[] = ["welcome", "ado", "ai", "source", "done"];

/** Minimal first-run wizard. Shows on first launch (or when re-run from
 *  settings). Each step is skippable — the wizard's job is to give the
 *  user a single linear path through the three things that matter (ADO,
 *  AI provider, optional source dir), not to block them. */
export function OnboardingDialog({ open, onClose }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  // Reset to welcome whenever the dialog reopens so re-running from settings
  // doesn't drop the user mid-flow.
  useEffect(() => {
    if (open) setStep("welcome");
  }, [open]);

  const finish = useCallback(async () => {
    await setOnboardingComplete(true);
    onClose();
  }, [onClose]);

  const goNext = () => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
  };
  const goBack = () => {
    const i = STEPS.indexOf(step);
    if (i > 0) setStep(STEPS[i - 1]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void finish();
      }}
    >
      <DialogContent className="max-w-[520px] gap-0 p-0">
        <StepProgress active={step} />
        <div className="px-6 pb-2 pt-5">
          {step === "welcome" ? <WelcomeStep /> : null}
          {step === "ado" ? <AdoStep onAdvance={goNext} /> : null}
          {step === "ai" ? <AiStep onAdvance={goNext} /> : null}
          {step === "source" ? <SourceStep onAdvance={goNext} /> : null}
          {step === "done" ? <DoneStep /> : null}
        </div>
        <DialogFooter className="border-t border-border/50 bg-card/40 px-6 py-3">
          <div className="flex w-full items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              onClick={goBack}
              disabled={step === "welcome"}
            >
              <HugeiconsIcon icon={ArrowLeft02Icon} size={11} strokeWidth={1.75} />
              Back
            </Button>
            <div className="flex items-center gap-2">
              {step !== "done" && step !== "welcome" ? (
                <Button size="sm" variant="ghost" onClick={goNext}>
                  Skip
                </Button>
              ) : null}
              {step === "done" ? (
                <Button size="sm" onClick={() => void finish()}>
                  Finish
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
                </Button>
              ) : (
                <Button size="sm" onClick={goNext}>
                  {step === "welcome" ? "Get started" : "Next"}
                  <HugeiconsIcon icon={ArrowRight02Icon} size={11} strokeWidth={1.75} />
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepProgress({ active }: { active: Step }) {
  const items: Array<{ id: Step; label: string }> = [
    { id: "welcome", label: "Welcome" },
    { id: "ado", label: "Azure DevOps" },
    { id: "ai", label: "AI provider" },
    { id: "source", label: "Source dir" },
    { id: "done", label: "Done" },
  ];
  const activeIdx = items.findIndex((i) => i.id === active);
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-card/40 px-6 py-2.5">
      {items.map((item, i) => {
        const isActive = i === activeIdx;
        const isCompleted = i < activeIdx;
        return (
          <div key={item.id} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-full text-[9.5px] font-mono",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isCompleted
                    ? "bg-primary/30 text-primary"
                    : "bg-muted text-muted-foreground/60",
              )}
            >
              {i + 1}
            </span>
            <span
              className={cn(
                "text-[10.5px]",
                isActive
                  ? "font-medium text-foreground"
                  : isCompleted
                    ? "text-muted-foreground line-through"
                    : "text-muted-foreground/60",
              )}
            >
              {item.label}
            </span>
            {i < items.length - 1 ? (
              <span className="text-muted-foreground/30">·</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// --- Steps ----------------------------------------------------------------

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-3">
      <DialogHeader className="px-0">
        <DialogTitle className="flex items-center gap-2 text-[14px]">
          <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={2} />
          Welcome to DevOps Studio
        </DialogTitle>
        <DialogDescription className="text-[11.5px]">
          A tester's workbench: paste a spec, get publishable test cases.
        </DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-1.5 text-[11.5px] text-foreground/85">
        <li className="flex items-start gap-2">
          <HugeiconsIcon
            icon={PlugSocketIcon}
            size={12}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-primary/80"
          />
          <span>
            Connect to <strong>Azure DevOps</strong> so generated cases can be
            published into your Test Plans.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <HugeiconsIcon
            icon={AiBrain01Icon}
            size={12}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-primary/80"
          />
          <span>
            Pick an <strong>AI provider</strong> (Claude Code, Anthropic,
            OpenAI, Gemini, or a local LM Studio / Ollama).
          </span>
        </li>
        <li className="flex items-start gap-2">
          <HugeiconsIcon
            icon={FolderOpenIcon}
            size={12}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-primary/80"
          />
          <span>
            Optionally, point at your <strong>source directory</strong> so the
            agent can ground cases in real code.
          </span>
        </li>
      </ul>
      <p className="text-[10.5px] text-muted-foreground/85">
        Each step is skippable — you can finish setup later from Settings.
      </p>
    </div>
  );
}

function AdoStep({ onAdvance }: { onAdvance: () => void }) {
  const [orgUrl, setOrgUrl] = useState("");
  const [project, setProject] = useState("");
  const [pat, setPat] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onTestAndSave = useCallback(async () => {
    if (!orgUrl.trim() || !project.trim() || !pat.trim()) {
      setError("Org URL, project, and PAT are all required.");
      return;
    }
    setTesting(true);
    setError(null);
    try {
      await setConnection({
        orgUrl: orgUrl.trim(),
        project: project.trim(),
        pat: pat.trim(),
      });
      const r = await testConnection();
      setResult(r);
      if (!r.ok) {
        setError(adoErrorMessage(r.error as AdoError | null | undefined));
      } else {
        // Auto-advance on success — the user's hands are already on the
        // form, no reason to make them click Next separately.
        setTimeout(onAdvance, 600);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, [orgUrl, project, pat, onAdvance]);

  return (
    <div className="flex flex-col gap-3">
      <DialogHeader className="px-0">
        <DialogTitle className="flex items-center gap-2 text-[14px]">
          <AzureDevOpsLogo size={13} />
          Connect Azure DevOps
        </DialogTitle>
        <DialogDescription className="text-[11.5px]">
          We need an org URL, project name, and a Personal Access Token with
          Test Plans (read + write) and Work Items (read + write) scopes.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <FieldRow label="Organization URL">
          <Input
            value={orgUrl}
            onChange={(e) => setOrgUrl(e.target.value)}
            placeholder="https://dev.azure.com/my-org"
            autoFocus
          />
        </FieldRow>
        <FieldRow label="Project">
          <Input
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="My Project"
          />
        </FieldRow>
        <FieldRow label="Personal Access Token">
          <Input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="••••••••"
          />
        </FieldRow>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void onTestAndSave()} disabled={testing}>
          {testing ? "Testing…" : "Test & save"}
        </Button>
        {result?.ok ? (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-primary">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
            Connected{result.identityName ? ` as ${result.identityName}` : ""}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="text-[10.5px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function AiStep({ onAdvance: _onAdvance }: { onAdvance: () => void }) {
  const selectedModelId = useChatStore((s) => s.selectedModelId);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKey = useChatStore((s) => s.setApiKey);
  const current = getModel(selectedModelId);
  const provider = getProvider(current.provider);
  const needsKey =
    provider.keyringAccount !== "" && !provider.keyOptional && !apiKeys[provider.id];
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    setKeyInput("");
    setKeySaved(false);
  }, [provider.id]);

  const onSaveKey = useCallback(async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      // Write to the OS keychain first, then mirror into the in-memory chat
      // store so the rest of the app sees the key without an extra reload.
      await setKey(provider.id, keyInput.trim());
      setApiKey(provider.id, keyInput.trim());
      setKeySaved(true);
    } finally {
      setSaving(false);
    }
  }, [keyInput, provider.id, setApiKey]);

  return (
    <div className="flex flex-col gap-3">
      <DialogHeader className="px-0">
        <DialogTitle className="flex items-center gap-2 text-[14px]">
          <HugeiconsIcon icon={AiBrain01Icon} size={13} strokeWidth={2} />
          Pick an AI provider
        </DialogTitle>
        <DialogDescription className="text-[11.5px]">
          You can change this any time from the status bar or Settings →
          Models. Local providers (LM Studio, Ollama, MLX) don't need an API
          key — they're configured in Settings.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label className="text-[11.5px] text-muted-foreground">
          Default model
        </Label>
        <ModelPicker
          value={selectedModelId}
          onChange={setSelectedModelId}
          side="bottom"
          align="start"
          trigger={({ label, provider: pid }) => (
            <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 text-[12px] hover:border-primary/60">
              <ProviderIcon provider={pid} size={12} />
              <span className="truncate">{label}</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {current.hint}
              </span>
            </span>
          )}
        />
      </div>
      {needsKey ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
          <Label className="text-[11.5px] text-amber-700 dark:text-amber-300">
            {provider.label} API key
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={provider.keyPrefix ?? "Paste your API key"}
            />
            <Button size="sm" onClick={() => void onSaveKey()} disabled={saving || !keyInput.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
          {keySaved ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-primary">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
              Key saved to OS keychain.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SourceStep({ onAdvance }: { onAdvance: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPick = useCallback(async () => {
    setError(null);
    try {
      const result = await openDialog({ directory: true, multiple: false });
      if (typeof result === "string") {
        await setSourceRoot(result);
        setPicked(result);
        setTimeout(onAdvance, 600);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onAdvance]);

  return (
    <div className="flex flex-col gap-3">
      <DialogHeader className="px-0">
        <DialogTitle className="flex items-center gap-2 text-[14px]">
          <HugeiconsIcon icon={FolderOpenIcon} size={13} strokeWidth={2} />
          Want code-grounded test cases?
        </DialogTitle>
        <DialogDescription className="text-[11.5px]">
          Point at your repo and the analyzer will read source files alongside
          the spec, producing cases anchored in actual code paths. You can
          skip this and add it later from the status bar.
        </DialogDescription>
      </DialogHeader>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void onPick()}
        className="self-start"
      >
        <HugeiconsIcon icon={FolderOpenIcon} size={11} strokeWidth={1.75} />
        Pick source directory…
      </Button>
      {picked ? (
        <p className="font-mono text-[10.5px] text-primary">{picked}</p>
      ) : null}
      {error ? (
        <p className="text-[10.5px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function DoneStep() {
  return (
    <div className="flex flex-col gap-3">
      <DialogHeader className="px-0">
        <DialogTitle className="flex items-center gap-2 text-[14px]">
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={13}
            strokeWidth={2}
            className="text-primary"
          />
          You're set up.
        </DialogTitle>
        <DialogDescription className="text-[11.5px]">
          Open the Generator from the sidebar (or press Ctrl/Cmd+K → "New
          generation") and paste a spec to see your first test cases.
        </DialogDescription>
      </DialogHeader>
      <p className="text-[10.5px] text-muted-foreground/85">
        Re-run this wizard any time from Settings → General.
      </p>
    </div>
  );
}

// --- Small bits -----------------------------------------------------------

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
