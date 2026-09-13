import { create } from "zustand";
import { restClient } from "../lib/restClient";
import { afterMutation } from "../lib/storeHelpers";
import type { ScenarioDto } from "../lib/protocol";

// Separate from configStore on purpose (mirrors the daemon's installation.json/scenarios split): hardware config rarely changes, scenarios often do.
interface ScenariosStore {
  scenarios: ScenarioDto[];
  loadScenarios: () => Promise<void>;
  deleteScenario: (scenarioId: string) => Promise<void>;
}

export const useScenariosStore = create<ScenariosStore>((set, get) => ({
  scenarios: [],
  loadScenarios: async () => {
    try {
      const scenarios = await restClient.getScenarios();
      set({ scenarios });
    } catch {
      // A missing/unreachable daemon here just means an empty picker -- the status dot already shows the problem.
    }
  },
  deleteScenario: afterMutation(
    (scenarioId: string) => restClient.deleteScenario(scenarioId),
    () => get().loadScenarios(),
  ),
}));
