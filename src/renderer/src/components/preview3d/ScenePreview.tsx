import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as THREE from "three";
import { useConfigStore } from "../../store/configStore";

/** Where each zone's label sits in the grid -- centralized so a future
 * per-fountain geometry (see this module's own history) can reuse the same
 * layout instead of re-deriving it. */
function gridPosition(index: number): [number, number, number] {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return [col * 1.8 - 2.7, 0, row * 1.8];
}

/**
 * Hand-rolled instead of @react-three/drei's <OrbitControls> -- drei is a
 * kitchen-sink package; pulling it in for this one helper also drags in
 * ~14MB of unrelated transitive deps (mediapipe hand-tracking, hls.js video
 * streaming) that this app has no use for. This is the same ~15-line wiring
 * drei's own OrbitControls does internally: instantiate against the R3F
 * camera/canvas, update it every frame, dispose on unmount.
 */
function CameraControls(): null {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;
    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl]);

  // Damping needs an explicit update() every frame to animate; without it
  // the camera would only move on pointer events.
  useFrame(() => controlsRef.current?.update());

  return null;
}

/**
 * Projects each zone's grid position to screen space every frame and writes
 * straight into the label `<div>`'s style through a ref -- no React state,
 * even though the camera (and therefore every label's screen position)
 * moves continuously while orbiting. No @react-three/drei <Html> (see
 * CameraControls' docstring for why this app avoids drei): a label is just
 * a projected 2D position, not worth a whole dependency.
 */
function ZoneLabelSync({
  zoneEntries,
  labelRefs,
}: {
  zoneEntries: Array<{ zoneId: number; position: [number, number, number] }>;
  labelRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
}): null {
  const { camera, size } = useThree();
  const vecRef = useRef(new THREE.Vector3());

  useFrame(() => {
    const vec = vecRef.current;
    for (const { zoneId, position } of zoneEntries) {
      const el = labelRefs.current.get(zoneId);
      if (!el) continue;

      vec.set(position[0], position[1] + 0.3, position[2]); // hover just above the grid
      vec.project(camera);

      if (vec.z > 1) {
        el.style.display = "none"; // behind the camera -- OrbitControls can get here
        continue;
      }
      el.style.display = "block";
      const x = (vec.x * 0.5 + 0.5) * size.width;
      const y = (-vec.y * 0.5 + 0.5) * size.height;
      el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
  });

  return null;
}

/**
 * No fountain geometry yet -- see git history for the boxes-as-zones
 * placeholder this replaced. Rather than keep a fake abstract stand-in
 * (three matte cubes on a grid, representing nothing physical), this shows
 * the honest current state: an empty stage with each zone's position
 * marked, ready for real per-fountain geometry once it exists. Zone
 * existence still comes from configStore (what's actually configured on
 * the daemon), not zonesStore -- see Sidebar.tsx's same fix.
 */
export function ScenePreview(): JSX.Element {
  const configuredZones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const labelRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  const zoneEntries = useMemo(
    () =>
      configuredZones
        .map((z) => z.zone_id)
        .sort((a, b) => a - b)
        .map((zoneId, index) => ({ zoneId, position: gridPosition(index) })),
    [configuredZones],
  );

  return (
    <div className="relative flex-1 overflow-hidden bg-bg-base">
      <Canvas camera={{ position: [4, 4, 6], fov: 50 }} dpr={[1, 1.5]}>
        <gridHelper args={[20, 20, "#464647", "#2d2d30"]} />
        <ZoneLabelSync zoneEntries={zoneEntries} labelRefs={labelRefs} />
        <CameraControls />
      </Canvas>

      <div className="pointer-events-none absolute inset-0">
        {zoneEntries.map(({ zoneId }) => (
          <div
            key={zoneId}
            ref={(el) => {
              if (el) labelRefs.current.set(zoneId, el);
              else labelRefs.current.delete(zoneId);
            }}
            style={{ left: 0, top: 0 }}
            className="absolute whitespace-nowrap rounded-control border border-border bg-bg-surface1 px-xs py-0.5 text-xs font-medium text-text-secondary"
          >
            Zone {zoneId}
          </div>
        ))}
      </div>

      {zoneEntries.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-text-disabled">No zones configured yet -- add one on the Devices tab first.</p>
        </div>
      )}
    </div>
  );
}
