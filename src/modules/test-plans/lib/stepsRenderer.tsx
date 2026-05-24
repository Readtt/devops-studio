import { cn } from "@/lib/utils";
import { EditableText } from "@/modules/generator/components/EditableText";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TestStep } from "@/modules/ado";

type Props = {
  steps: TestStep[];
  /** When provided, the table swaps to editable mode: action + expected are
   *  click-to-edit, an "+ add step" row appears below, and each row gains a
   *  trash button (disabled when only one step remains, since ADO requires
   *  at least one step on a Test Case). Omitting this prop keeps the table
   *  in its original read-only mode. */
  onChange?: (next: TestStep[]) => void;
  /** Optional flag — when true the inputs are disabled (e.g. a save is in
   *  flight). Display still reads as editable so the user knows the affordance
   *  exists; clicks just no-op. */
  disabled?: boolean;
};

/**
 * Steps table for a Test Case. Read-only by default, editable when an
 * onChange handler is passed. Action / Expected text is plain — we strip
 * HTML when we parse from ADO (see strip_html in test_cases.rs).
 *
 * Edit mode rebuilds the whole step array on every commit and hands it to
 * onChange. Callers are expected to debounce / save asynchronously and
 * revert on failure; the table itself stays presentational so we don't
 * tangle save state into the renderer.
 */
export function StepsTable({ steps, onChange, disabled }: Props) {
  // "editable" is a structural flag — does this table render the edit chrome
  // (trash column, "+ add step" footer, EditableText cells) at all? It must
  // stay stable across saves so the row layout doesn't flicker every time the
  // user adds or deletes a step. `disabled` is a transient input-locked state
  // (a save is in flight); we pass it through as `readOnly` to EditableText
  // and as `disabled` on the buttons, but we never restructure on it.
  const editable = !!onChange;
  const inputsLocked = !!disabled;

  if (steps.length === 0 && !editable) {
    return (
      <p className="text-[11.5px] italic text-muted-foreground">
        No steps recorded on this test case.
      </p>
    );
  }

  const commit = (next: TestStep[]) => {
    if (inputsLocked) return;
    // Reindex so the wire format stays canonical (1-based, sequential).
    onChange?.(next.map((s, i) => ({ ...s, index: i + 1 })));
  };
  const editStep = (i: number, patch: Partial<Pick<TestStep, "action" | "expected">>) => {
    commit(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  const removeStep = (i: number) => {
    if (steps.length <= 1) return;
    commit(steps.filter((_, idx) => idx !== i));
  };
  const addStep = () => {
    commit([...steps, { index: steps.length + 1, action: "", expected: "" }]);
  };

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      {/* table-fixed keeps Action/Expected at a stable 50/50 split whether each
       *  cell is a span (small min-content) or a textarea (cols=20 intrinsic
       *  preferred width). Without it, clicking to edit reflows the column
       *  narrower mid-edit. */}
      <table className="w-full table-fixed text-[12px]">
        <thead className="bg-muted/50 text-[10.5px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="w-8 px-2 py-1.5 text-left font-medium">#</th>
            <th className="px-2 py-1.5 text-left font-medium">Action</th>
            <th className="px-2 py-1.5 text-left font-medium">
              Expected Result
            </th>
            {editable ? <th className="w-8" /> : null}
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr
              key={s.index}
              className="group/step border-t border-border/40 align-top"
            >
              <td className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {s.index}
              </td>
              <td className="whitespace-pre-wrap px-2 py-1.5">
                {editable ? (
                  <EditableText
                    value={s.action}
                    onCommit={(next) => editStep(i, { action: next })}
                    placeholder="(action)"
                    variant="multiline"
                    ariaLabel={`Step ${s.index} action`}
                    className="block"
                    readOnly={inputsLocked}
                  />
                ) : (
                  s.action
                )}
              </td>
              <td className="whitespace-pre-wrap px-2 py-1.5">
                {editable ? (
                  <EditableText
                    value={s.expected}
                    onCommit={(next) => editStep(i, { expected: next })}
                    placeholder="(expected)"
                    variant="multiline"
                    ariaLabel={`Step ${s.index} expected`}
                    className="block"
                    readOnly={inputsLocked}
                  />
                ) : (
                  s.expected
                )}
              </td>
              {editable ? (
                <td className="px-1 py-1.5 text-right">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Remove step ${s.index}`}
                        disabled={steps.length <= 1 || inputsLocked}
                        onClick={() => removeStep(i)}
                        className={cn(
                          "inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground/40 opacity-0 transition-all group-hover/step:opacity-100 hover:bg-destructive/15 hover:text-destructive",
                          (steps.length <= 1 || inputsLocked) && "cursor-not-allowed",
                        )}
                      >
                        <HugeiconsIcon
                          icon={Cancel01Icon}
                          size={11}
                          strokeWidth={2}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-[11px]">
                      {steps.length <= 1
                        ? "A test case must have at least one step"
                        : "Remove this step"}
                    </TooltipContent>
                  </Tooltip>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {editable ? (
        <button
          type="button"
          onClick={addStep}
          disabled={inputsLocked}
          className={cn(
            "flex w-full items-center justify-center gap-1 border-t border-dashed border-border/50 bg-card/30 px-2 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors",
            inputsLocked
              ? "cursor-not-allowed opacity-60"
              : "hover:bg-primary/[0.04] hover:text-primary",
          )}
        >
          + add step
        </button>
      ) : null}
    </div>
  );
}
