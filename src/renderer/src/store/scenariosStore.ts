import { create } from "zustand";
import { restClient } from "../lib/restClient";
import type { ScenarioDto } from "../lib/protocol";

// Kept separate from configStore (driver instances/devices) on purpose --
// same reasoning as the installation.json / data/scenarios split on the
// daemon: hardware config changes rarely, scenarios change often. No reason
// for a scenario list refresh to touch anything hardware-related.
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
      // A missing/unreachable daemon here just means an empty picker --
      // the connection status dot already tells the operator what's wrong.
    }
  },
  deleteScenario: async (scenarioId) => {
    await restClient.deleteScenario(scenarioId);
    await get().loadScenarios();
  },
}));
