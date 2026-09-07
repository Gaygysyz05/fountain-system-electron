import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";
import { useConfigStore } from "../../store/configStore";

// Served from src/renderer/public/models/ -- electron-vite copies `public/`
// verbatim into out/renderer/ at build time and this app's Vite base is
// relative (see index.html's built <script src="./assets/...">, needed
// because a packaged build loads via file://, which has no notion of a
// server root an absolute "/models/..." path could resolve against).
const MODEL_URL = "./models/fontan.glb";

// The source file's own scale/units are whatever the 3D artist modeled
// in -- centimeters, a 1-unit-per-meter rig, whatever. Rather than hardcode
// a scale factor that only happens to look right for this one file,
// FountainModel measures the loaded geometry's own bounding box and
// normalizes it to a fixed target size, so the preview frames correctly
// regardless of what the .glb turns out to actually contain.
const TARGET_SIZE = 6;

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
 * Loads fontan.glb once, centers and normalizes it, and plays back
 * whatever animations (if any) it was exported with -- a rotating pump
 * impeller, a jet's own bob, whatever the 3D artist baked in. Same
 * manual-loader approach as CameraControls above (GLTFLoader straight from
 * three/examples/jsm, not drei's <useGLTF>) for the same reason: this app
 * deliberately doesn't pull in drei.
 */
function FountainModel({ onError }: { onError: (message: string) => void }): JSX.Element | null {
  const [model, setModel] = useState<THREE.Group | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new GLTFLoader();

    loader.load(
      MODEL_URL,
      (gltf) => {
        if (cancelled) return;
        const scene = gltf.scene;

        const box = new THREE.Box3().setFromObject(scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const largestDimension = Math.max(size.x, size.y, size.z) || 1;
        const scale = TARGET_SIZE / largestDimension;

        // Object3D applies scale before translation (world = position + scale
        // * localVertex), so the position needed to land a given LOCAL point
        // at a specific WORLD coordinate is always -localPoint * scale, not
        // the unscaled offset -- X/Z center on the origin, Y sits the
        // model's own lowest point on the ground plane (y=0) instead of on
        // its vertical bounding-box middle, so it stands ON the grid rather
        // than floating through it.
        scene.scale.setScalar(scale);
        scene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

        if (gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(scene);
          for (const clip of gltf.animations) mixer.clipAction(clip).play();
          mixerRef.current = mixer;
        }

        setModel(scene);
      },
      undefined,
      (err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      },
    );

    return () => {
      cancelled = true;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a stable setter from the parent, loading is a one-time mount effect
  }, []);

  useFrame((_, delta) => mixerRef.current?.update(delta));

  return model ? <primitive object={model} /> : null;
}

/**
 * Renders the real fountain model (fontan.glb, see FountainModel above)
 * instead of the abstract boxes-as-zones placeholder this used to be (see
 * git history) -- an operator previewing a show now sees the actual
 * installation, not an empty stage with position markers. Zone labels keep
 * their existing grid layout for now: the model is one static mesh with no
 * per-zone parts this app can identify, so there's no real geometry yet to
 * anchor a label to a specific physical zone. Zone existence still comes
 * from configStore (what's actually configured on the daemon), not
 * zonesStore -- see Sidebar.tsx's same fix.
 */
export function ScenePreview(): JSX.Element {
  const configuredZones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const labelRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [modelError, setModelError] = useState<string | null>(null);

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
      <Canvas camera={{ position: [6, 5, 9], fov: 50 }} dpr={[1, 1.5]}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.2} />
        <directionalLight position={[-5, 4, -5]} intensity={0.4} />
        <gridHelper args={[20, 20, "#464647", "#2d2d30"]} />
        <FountainModel onError={setModelError} />
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

      {modelError && (
        <div className="pointer-events-none absolute bottom-md left-1/2 -translate-x-1/2 rounded-control border border-danger bg-bg-surface1 px-md py-xs text-xs text-danger">
          Couldn't load fontan.glb: {modelError}
        </div>
      )}
    </div>
  );
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
