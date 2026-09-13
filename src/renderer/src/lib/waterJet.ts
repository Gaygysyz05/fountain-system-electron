/** Pure sizing logic for the 3D preview's live water-jet proxies (see ScenePreview.tsx's WaterJets) -- kept separate from the R3F rendering so it's unit-testable without a WebGL context. */

export const JET_VALVE_HEIGHT = 1.1;
export const JET_MOTOR_MAX_HEIGHT = 1.8;
export const JET_MOTOR_MAX_FREQUENCY = 50; // Hz -- matches AsyncInverterController's fallback max_frequency when a drive hasn't reported its own P0.06 yet

export interface JetState {
  visible: boolean;
  height: number;
}

/** A valve is a level-triggered on/off, so its jet is a fixed height whenever `on`. A motor's jet rises with its commanded frequency, clamped to a sane minimum so a barely-spinning drive still shows something rather than a zero-height cone. */
export function jetState(category: "valve" | "motor" | "light", state: Record<string, unknown> | undefined): JetState {
  if (category === "valve") {
    return { visible: Boolean(state?.on), height: JET_VALVE_HEIGHT };
  }
  if (category === "motor") {
    const frequency = Number(state?.frequency ?? 0);
    const visible = Boolean(state?.active) && frequency > 0;
    const height = Math.max(0.1, Math.min(1, frequency / JET_MOTOR_MAX_FREQUENCY)) * JET_MOTOR_MAX_HEIGHT;
    return { visible, height };
  }
  return { visible: false, height: 0 };
}
