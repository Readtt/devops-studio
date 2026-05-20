import { GeneratorPane } from "./GeneratorPane";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenCase?: (input: { caseId: number; title: string }) => void;
};

export function GeneratorStack({ tabs, activeId, onOpenCase }: Props) {
  const gen = tabs.find((t) => t.kind === "generator");
  if (!gen || gen.kind !== "generator") return null;
  const visible = gen.id === activeId;
  return (
    <div
      className="absolute inset-0"
      style={{ visibility: visible ? "visible" : "hidden" }}
      aria-hidden={!visible}
    >
      <GeneratorPane
        initialPlanId={gen.initialPlanId}
        initialSuiteId={gen.initialSuiteId}
        onOpenCase={onOpenCase}
      />
    </div>
  );
}
