import { useState } from "react";
import { analyzeAudioBuffer } from "../../lib/audioAnalysis";
import { generateScenarioFromMusic, type MusicGeneratorCategory } from "../../lib/musicGenerator";
import { restClient } from "../../lib/restClient";
import { describeError } from "../../lib/errors";
import { INPUT_CLASS } from "../../lib/styles";
import type { DeviceDto, ZoneConfigDto } from "../../lib/protocol";

const inputClass = INPUT_CLASS;

const CATEGORY_LABELS: Record<MusicGeneratorCategory, string> = {
  valve: "Valves",
  motor: "Motors",
  light: "Lights",
};

/** Runs the whole "auto-choreograph a show from a music file" pipeline: decode -> analyze (spectral-flux onsets + energy envelopes, see audioAnalysis.ts) -> generate (musicGenerator.ts) -> hand the result to the caller as a ready-to-review ScenarioFile. Analysis runs entirely client-side (no daemon/Python involvement, see musicGenerator.ts's own header) so it works the same whether or not real hardware is connected. */
export function GenerateFromMusicDialog({
  zone,
  onGenerated,
  onClose,
}: {
  zone: ZoneConfigDto;
  onGenerated: (result: { name: string; duration: number; musicFile: string; events: ReturnType<typeof generateScenarioFromMusic> }) => void;
  onClose: () => void;
}): JSX.Element {
  const [musicFile, setMusicFile] = useState<string | null>(null);
  const [categories, setCategories] = useState<Set<MusicGeneratorCategory>>(new Set(["valve", "motor", "light"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCategory(category: MusicGeneratorCategory): void {
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function devicesOf(category: MusicGeneratorCategory): DeviceDto[] {
    return zone.devices.filter((d) => d.category === category);
  }

  async function handlePickMusic(): Promise<void> {
    const picked = await window.electron.selectMusicFile();
    if (picked) setMusicFile(picked);
  }

  async function handleGenerate(): Promise<void> {
    if (!musicFile) {
      setError("Choose a music file first.");
      return;
    }
    if (categories.size === 0) {
      setError("Pick at least one device category.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const bytes = await (await fetch(restClient.audioUrl(musicFile))).arrayBuffer();
      const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioContextCtor();
      let analysis;
      try {
        const buffer = await audioContext.decodeAudioData(bytes.slice(0));
        analysis = analyzeAudioBuffer(buffer);
      } finally {
        void audioContext.close();
      }

      const events = generateScenarioFromMusic(analysis, {
        categories,
        valveDeviceIds: devicesOf("valve").map((d) => d.device_id),
        motorDeviceIds: devicesOf("motor").map((d) => d.device_id),
        lightDeviceIds: devicesOf("light").map((d) => d.device_id),
      });

      onGenerated({
        name: `${musicFile.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "")} (generated)`,
        duration: Math.round(analysis.duration * 100) / 100,
        musicFile,
        events,
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div className="flex w-96 flex-col gap-md rounded-panel border border-border bg-bg-surface1 p-lg">
        <div className="flex items-center justify-between">
          <span className="text-base font-medium text-text-primary">Generate show from music</span>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary">
            ✕
          </button>
        </div>

        <p className="text-xs text-text-muted">
          Analyzes the track's beats and energy (locally, no upload) and auto-places valve/motor/light cues synced to it. The result is a normal
          scenario you can review and edit before saving.
        </p>

        <button
          onClick={() => void handlePickMusic()}
          className={`${inputClass} flex items-center gap-xs px-sm text-left hover:bg-bg-surface2`}
        >
          🎵 <span className="truncate">{musicFile ? musicFile.replace(/^.*[\\/]/, "") : "Choose music…"}</span>
        </button>

        <div className="flex flex-col gap-xs">
          <span className="text-xs text-text-secondary">Include</span>
          {(Object.keys(CATEGORY_LABELS) as MusicGeneratorCategory[]).map((category) => (
            <label key={category} className="flex items-center gap-xs text-sm text-text-primary">
              <input type="checkbox" checked={categories.has(category)} onChange={() => toggleCategory(category)} className="h-3 w-3 accent-accent" />
              {CATEGORY_LABELS[category]}
              <span className="text-xs text-text-muted">({devicesOf(category).length} device{devicesOf(category).length === 1 ? "" : "s"})</span>
            </label>
          ))}
        </div>

        {error && <p className="text-xs text-danger">⚠ {error}</p>}

        <div className="flex justify-end gap-xs">
          <button onClick={onClose} className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2">
            Cancel
          </button>
          <button
            onClick={() => void handleGenerate()}
            disabled={busy}
            className="h-control rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Analyzing…" : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}
