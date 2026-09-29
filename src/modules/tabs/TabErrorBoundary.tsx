import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  /** What the fallback's "Close tab" does. */
  onClose: () => void;
  children: ReactNode;
};

type State = { error: Error | null };

/**
 * Keeps one tab's render failure inside that tab. Without it, a throw while
 * rendering any tab unmounts the whole main window, and because tabs are
 * restored at launch (hidden ones are mounted too), a tab that throws on
 * restore blanks the app on every start until its saved state is deleted by
 * hand. Fixing a known cause doesn't cover the next one; this does.
 */
export class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[tabs] a tab failed to render", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="max-w-[420px]">
          <p className="text-[13px] font-medium">This tab couldn't be shown</p>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Something in it failed to load. The rest of the app is fine. Try
            again, or close the tab and open it fresh.
          </p>
          <p className="mt-2 font-mono text-[10.5px] break-words text-muted-foreground/80">
            {error.message}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => this.setState({ error: null })}
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
