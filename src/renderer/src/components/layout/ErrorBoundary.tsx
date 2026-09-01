import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Without this, any uncaught render error unmounts everything inside it --
 * exactly the blank-screen symptom hit while testing scene/cue changes.
 * React error boundaries must be class components (no hook equivalent
 * exists yet), and must wrap the crash-prone tree from OUTSIDE -- an error
 * boundary can't catch an error thrown by its own children if it's the
 * thing crashing. Used at two levels (see App.tsx and AppShell.tsx): a root
 * one as the last resort, and one scoped to just the active tab's content
 * so a crash there can't take the header/Emergency Stop/StatusBar down with
 * it. `h-full`, not `h-screen`, so the fallback fits whichever of those two
 * containers it's rendering into instead of always claiming the full
 * viewport. Shows the actual error + component stack so a crash is
 * diagnosable from a screenshot instead of just "the screen is empty."
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] caught:", error, info.componentStack);
    this.setState({ info });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full flex-col gap-md overflow-auto bg-bg-base p-lg text-text-primary">
        <h1 className="text-lg font-medium text-danger">Something crashed</h1>
        <p className="text-sm text-text-secondary">{this.state.error.message}</p>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-panel border border-border bg-bg-surface1 p-md font-mono text-xs text-text-muted">
          {this.state.error.stack}
          {this.state.info?.componentStack}
        </pre>
        <button
          onClick={() => this.setState({ error: null, info: null })}
          className="h-control w-fit rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover"
        >
          Try to continue
        </button>
      </div>
    );
  }
}
