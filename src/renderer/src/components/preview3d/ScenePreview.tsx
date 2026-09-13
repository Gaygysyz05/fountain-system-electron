import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import * as THREE from "three";
import { errorMessage } from "../../lib/errors";
import { useConfigStore } from "../../store/configStore";

// Relative path is required: a packaged build loads via file://, which has no server root for an absolute "/models/..." path to resolve against.
const MODEL_URL = "./models/fountain.gltf";

// Target size the model's bounding box is normalized to, regardless of the model's own modeled units/scale.
const TARGET_SIZE = 6;

/** Hand-rolled instead of @react-three/drei's <OrbitControls> to avoid drei's ~14MB of unrelated transitive deps (mediapipe, hls.js). */
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

  // Damping needs an explicit update() every frame; without it the camera only moves on pointer events.
  useFrame(() => controlsRef.current?.update());

  return null;
}

/** Metallic/glossy surfaces (glTF's default PBR) are lit mainly by reflection and render black with no environment to reflect; RoomEnvironment bakes a generic stand-in via PMREM instead of shipping a real HDRI. */
function SceneEnvironment(): null {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmremGenerator = new THREE.PMREMGenerator(gl);
    const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    // RoomEnvironment is deliberately bright and at full strength washes out non-metallic surfaces too; environmentIntensity scales only its contribution, independent of the other lights.
    scene.environmentIntensity = 0.35;
    return () => {
      scene.environment = null;
      envTexture.dispose();
      pmremGenerator.dispose();
    };
  }, [gl, scene]);

  return null;
}

/** Loads the fountain model once, centers/normalizes it, and plays any baked-in animations; uses GLTFLoader directly rather than drei's useGLTF for the same reason as CameraControls. */
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

        // Position must be -localPoint * scale (scale applies before translation): centers X/Z on the origin and grounds Y at the model's lowest point (y=0) rather than its bbox middle.
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
        // Not a daemon call, so describeError's "can't reach the daemon" wording would be wrong here.
        if (!cancelled) onError(errorMessage(err));
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

export function ScenePreview(): JSX.Element {
  const configuredZones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  return (
    <div className="relative flex-1 overflow-hidden bg-bg-base">
      <Canvas camera={{ position: [6, 5, 9], fov: 50 }} dpr={[1, 1.5]}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.2} />
        <directionalLight position={[-5, 4, -5]} intensity={0.4} />
        <gridHelper args={[20, 20, "#464647", "#2d2d30"]} />
        <SceneEnvironment />
        <FountainModel onError={setModelError} />
        <CameraControls />
      </Canvas>

      {configuredZones.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-text-disabled">No zones configured yet -- add one on the Devices tab first.</p>
        </div>
      )}

      {modelError && (
        <div className="pointer-events-none absolute bottom-md left-1/2 -translate-x-1/2 rounded-control border border-danger bg-bg-surface1 px-md py-xs text-xs text-danger">
          Couldn't load fountain.gltf: {modelError}
        </div>
      )}
    </div>
  );
}
