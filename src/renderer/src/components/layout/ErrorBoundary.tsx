import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/** Must be a class component (no hook equivalent for error boundaries) and must wrap the crash-prone tree from outside, since it can't catch an error thrown by its own children; `h-full` (not `h-screen`) lets the fallback fit whichever container it's rendering into. */
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
