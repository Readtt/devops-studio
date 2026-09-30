import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  /** What the fallback's "Close tab" does. */
  onClose: () => void;
  children: ReactNode;
};

type State = { failed: boolean; error: unknown };

/**
 * Keeps one tab's render failure inside that tab. Without it, a throw while
 * rendering any tab unmounts the whole main window, and because tabs are
 * restored at launch (hidden ones are mounted too), a tab that throws on
 * restore blanks the app on every start until its saved state is deleted by
 * hand. Fixing a known cause doesn't cover the next one; this does.
 */
export class TabErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, error: null };

  // A flag, not the error itself: a throw of `undefined` or `null` is still a
  // failed render.
  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[tabs] a tab failed to render", error, info.componentStack);
  }

  render() {
    const { failed, error } = this.state;
    if (!failed) return this.props.children;
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="max-w-[420px]">
          <p className="text-[13px] font-medium">This tab couldn't be shown</p>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Something in it failed to load. The rest of the app is fine. Try
            again, or close the tab and open it fresh.
          </p>
          <p className="mt-2 font-mono text-[10.5px] break-words text-muted-foreground/80">
            {message}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => this.setState({ failed: false, error: null })}
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={this.props.onClose}>
            Close tab
          </Button>
        </div>
      </div>
    );
  }
}
