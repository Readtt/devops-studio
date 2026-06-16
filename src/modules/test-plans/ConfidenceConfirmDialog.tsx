// Large-suite confirmation for bulk confidence scoring. Driven entirely by the
// useSuiteConfidence store's pendingConfirm slot, so it can live as a bare mount
// next to the progress capsule in App.tsx.

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSuiteConfidence } from "./hooks/useSuiteConfidence";

export function ConfidenceConfirmDialog() {
  const pending = useSuiteConfidence((s) => s.pendingConfirm);
  const confirmPending = useSuiteConfidence((s) => s.confirmPending);
  const cancelPending = useSuiteConfidence((s) => s.cancelPending);

  const count = pending?.targets.length ?? 0;
  const suiteName = pending?.suiteName;

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) cancelPending();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Score {count} cases{suiteName ? ` in ${suiteName}` : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This runs {count} confidence evaluations — one full AI pass per case,
            which can take a while and use tokens. Already-scored cases are
            skipped. You can stop anytime from the progress capsule.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={() => confirmPending()}>
            Score {count} cases
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
