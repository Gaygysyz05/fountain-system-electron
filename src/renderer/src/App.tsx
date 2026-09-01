import { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell";
import { ErrorBoundary } from "./components/layout/ErrorBoundary";
import { daemonClient } from "./store/connectionStore";
import "./store/zonesStore"; // side-effect import: wires daemonClient events into the store

export function App(): JSX.Element {
  useEffect(() => {
    daemonClient.connect();
    return () => daemonClient.disconnect();
  }, []);

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
