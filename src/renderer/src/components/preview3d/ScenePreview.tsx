import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import * as THREE from "three";
import { errorMessage } from "../../lib/errors";
import { useConfigStore } from "../../store/configStore";
import { useConnectionStore } from "../../store/connectionStore";
import { useZonesStore, deviceStateKey } from "../../store/zonesStore";
import { INPUT_CLASS } from "../../lib/styles";
import { jetState } from "../../lib/waterJet";

const inputClass = INPUT_CLASS;

// Relative path is required: a packaged build loads via file://, which has no server root for an absolute "/models/..." path to resolve against.
const MODEL_URL = "./models/fountain.gltf";

// Target size the model's bounding box is normalized to, regardless of the model's own modeled units/scale.
const TARGET_SIZE = 6;

const JET_RADIUS = 0.07; // the model ships only the physical nozzle housings, no spray geometry -- a simple cone stands in, sized by lib/waterJet.ts

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
function FountainModel({
  onLoaded,
  onError,
  pickable,
  onPickNode,
}: {
  onLoaded: (scene: THREE.Group) => void;
  onError: (message: string) => void;
  pickable: boolean;
  onPickNode: (nodeName: string) => void;
}): JSX.Element | null {
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
        onLoaded(scene);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLoaded/onError are stable setters from the parent, loading is a one-time mount effect
  }, []);

  useFrame((_, delta) => mixerRef.current?.update(delta));

  const handleClick = pickable
    ? (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        if (event.object.name) onPickNode(event.object.name);
      }
    : undefined;

  return model ? <primitive object={model} onClick={handleClick} /> : null;
}

interface MappedDevice {
  deviceId: string;
  zoneId: number;
  instanceId: string;
  channel: string;
  // Only valve/motor -- mappedDevices below already filters out "light" (nothing to animate as a jet), so this stays narrow rather than widening every consumer to handle a case that can't occur.
  category: "valve" | "motor";
  modelNode: string;
}

/** One translucent cone per device that's been assigned a 3D node (see the mapping editor below), sized/shown from that device's LIVE state -- a valve's water either is or isn't flowing, a motor's jet rises with its commanded frequency. */
function WaterJets({ scene, devices }: { scene: THREE.Group; devices: MappedDevice[] }): JSX.Element {
  const liveDevices = useZonesStore((s) => s.devices);

  return (
    <>
      {devices.map((d) => {
        const node = scene.getObjectByName(d.modelNode);
        if (!node) return null;
        const position = node.getWorldPosition(new THREE.Vector3());
        const live = liveDevices.get(deviceStateKey(d.zoneId, d.instanceId, d.channel))?.state;
        const { visible, height } = jetState(d.category, live);
        if (!visible) return null;

        return (
          <mesh key={d.deviceId} position={[position.x, position.y + height / 2, position.z]}>
            <coneGeometry args={[JET_RADIUS, height, 10]} />
            <meshStandardMaterial color="#7ec8e3" transparent opacity={0.55} emissive="#3a8fc4" emissiveIntensity={0.3} />
          </mesh>
        );
      })}
    </>
  );
}

/** A small marker at the currently-selected node in the mapping editor, so clicking a mesh in a dense cluster confirms which one actually got picked. */
function SelectionMarker({ scene, nodeName }: { scene: THREE.Group; nodeName: string | null }): JSX.Element | null {
  if (!nodeName) return null;
  const node = scene.getObjectByName(nodeName);
  if (!node) return null;
  const position = node.getWorldPosition(new THREE.Vector3());
  return (
    <mesh position={[position.x, position.y, position.z]}>
      <sphereGeometry args={[0.14, 12, 12]} />
      <meshBasicMaterial color="#ffcc00" wireframe />
    </mesh>
  );
}

/** A smaller marker at every OTHER already-mapped node, so the whole mapping is visible at a glance while editing -- without this, only the one node just clicked showed anything, and the rest of the assignments were invisible until clicked one at a time. */
function MappedNodeMarkers({ scene, devices, exceptNode }: { scene: THREE.Group; devices: MappedDevice[]; exceptNode: string | null }): JSX.Element {
  return (
    <>
      {devices.map((d) => {
        if (d.modelNode === exceptNode) return null; // SelectionMarker already covers this one
        const node = scene.getObjectByName(d.modelNode);
        if (!node) return null;
        const position = node.getWorldPosition(new THREE.Vector3());
        return (
          <mesh key={d.deviceId} position={[position.x, position.y, position.z]}>
            <sphereGeometry args={[0.09, 10, 10]} />
            <meshBasicMaterial color="#3ddc84" wireframe />
          </mesh>
        );
      })}
    </>
  );
}

export function ScenePreview(): JSX.Element {
  const configuredZones = useConfigStore((s) => s.zones);
  const loadZones = useConfigStore((s) => s.loadZones);
  const selectedZoneId = useConfigStore((s) => s.selectedZoneId);
  const setDeviceModelNode = useConfigStore((s) => s.setDeviceModelNode);
  const sendCommand = useConnectionStore((s) => s.sendCommand);
  const [modelError, setModelError] = useState<string | null>(null);
  const [scene, setScene] = useState<THREE.Group | null>(null);

  const [mappingMode, setMappingMode] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [assignDeviceId, setAssignDeviceId] = useState("");
  const [testingOn, setTestingOn] = useState(false);
  const testingRef = useRef<MappedDevice | null>(null); // the device the Test button last turned on, if any -- read from a ref so the unmount/selection-change cleanup below always sees the latest value

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  const mappedDevices = useMemo<MappedDevice[]>(
    () =>
      configuredZones.flatMap((zone) =>
        zone.devices
          .filter((d) => d.model_node && (d.category === "valve" || d.category === "motor"))
          .map((d) => ({
            deviceId: d.device_id,
            zoneId: zone.zone_id,
            instanceId: d.instance_id,
            channel: d.channel,
            category: d.category as "valve" | "motor",
            modelNode: d.model_node as string,
          })),
      ),
    [configuredZones],
  );

  const selectedZone = configuredZones.find((z) => z.zone_id === selectedZoneId) ?? null;
  const assignableDevices = (selectedZone?.devices ?? []).filter((d) => d.category === "valve" || d.category === "motor");
  // Searched across every zone, not just the selected one -- a node could already be assigned to a device that belongs to a different zone than whatever the sidebar currently has selected.
  const currentAssignment = mappedDevices.find((d) => d.modelNode === selectedNode) ?? null;

  async function handleAssign(): Promise<void> {
    if (!selectedZoneId || !selectedNode || !assignDeviceId) return;
    await setDeviceModelNode(selectedZoneId, assignDeviceId, selectedNode);
    setAssignDeviceId("");
  }

  async function handleClear(): Promise<void> {
    if (!currentAssignment) return;
    await setDeviceModelNode(currentAssignment.zoneId, currentAssignment.deviceId, null);
  }

  function testParameters(category: "valve" | "motor", on: boolean): Record<string, unknown> {
    // 10Hz matches DeviceConfigPanel's own motor test-fire convention -- one shared "what does a manual test look like" number, not a second one invented here.
    return category === "valve" ? { on } : { active: on, frequency: on ? 10 : 0 };
  }

  function stopTesting(): void {
    const device = testingRef.current;
    if (!device) return;
    testingRef.current = null;
    void sendCommand({ command: "SET_DEVICE_STATE", zone_id: device.zoneId, device_id: device.deviceId, parameters: testParameters(device.category, false) });
  }

  function toggleTest(): void {
    if (!currentAssignment) return;
    if (testingRef.current) {
      stopTesting();
      setTestingOn(false);
      return;
    }
    testingRef.current = currentAssignment;
    void sendCommand({ command: "SET_DEVICE_STATE", zone_id: currentAssignment.zoneId, device_id: currentAssignment.deviceId, parameters: testParameters(currentAssignment.category, true) });
    setTestingOn(true);
  }

  // Nothing left energized just because the operator clicked a different
  // node, hit "Done mapping", or navigated away from Preview entirely --
  // same reasoning as DeviceConfigPanel's ValveTestControl.
  useEffect(() => {
    setTestingOn(false);
    return () => stopTesting();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection-change/unmount only, stopTesting reads testingRef for the latest value
  }, [selectedNode]);

  return (
    <div className="relative flex-1 overflow-hidden bg-bg-base">
      <Canvas camera={{ position: [6, 5, 9], fov: 50 }} dpr={[1, 1.5]}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.2} />
        <directionalLight position={[-5, 4, -5]} intensity={0.4} />
        <gridHelper args={[20, 20, "#464647", "#2d2d30"]} />
        <SceneEnvironment />
        <FountainModel onLoaded={setScene} onError={setModelError} pickable={mappingMode} onPickNode={setSelectedNode} />
        {/* Kept mounted in mapping mode too, not just normal viewing -- otherwise the Test button's whole point (see it actually spray) has nothing to show. */}
        {scene && <WaterJets scene={scene} devices={mappedDevices} />}
        {scene && mappingMode && (
          <>
            <SelectionMarker scene={scene} nodeName={selectedNode} />
            <MappedNodeMarkers scene={scene} devices={mappedDevices} exceptNode={selectedNode} />
          </>
        )}
        <CameraControls />
      </Canvas>

      <div className="absolute right-md top-md flex flex-col items-end gap-xs">
        <button
          onClick={() => {
            setMappingMode((v) => !v);
            setSelectedNode(null);
          }}
          className="h-control rounded-control border border-border bg-bg-surface1 px-md text-sm text-text-primary hover:bg-bg-surface2"
        >
          {mappingMode ? "Done mapping" : "Edit nozzle mapping"}
        </button>

        {mappingMode && (
          <div className="w-72 rounded-panel border border-border bg-bg-surface1 p-md text-sm">
            {!selectedNode ? (
              <p className="text-text-muted">Click a part of the model to select it.</p>
            ) : (
              <div className="flex flex-col gap-sm">
                <div>
                  <span className="text-text-muted">Selected: </span>
                  <span className="font-medium text-text-primary">{selectedNode}</span>
                </div>

                {currentAssignment ? (
                  <div className="flex flex-col gap-xs">
                    <div>
                      <span className="text-text-muted">Assigned to: </span>
                      <span className="font-medium text-text-primary">{currentAssignment.deviceId}</span>
                    </div>
                    <button
                      onClick={toggleTest}
                      title="Fires the same SET_DEVICE_STATE the Devices tab's manual test uses -- only visible if this device's actual hardware is connected."
                      className={`h-control rounded-control border border-border px-sm text-xs text-text-primary hover:bg-bg-surface2 ${testingOn ? "bg-warning/20 text-warning" : "bg-bg-surface3"}`}
                    >
                      {testingOn ? "Stop test" : "Test"}
                    </button>
                    <button onClick={() => void handleClear()} className="h-control rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary hover:bg-bg-surface2">
                      Clear assignment
                    </button>
                  </div>
                ) : selectedZoneId === null ? (
                  <p className="text-text-muted">Select a zone in the sidebar to assign a device.</p>
                ) : (
                  <div className="flex flex-col gap-xs">
                    <select value={assignDeviceId} onChange={(e) => setAssignDeviceId(e.target.value)} className={inputClass}>
                      <option value="">Assign device…</option>
                      {assignableDevices.map((d) => (
                        <option key={d.device_id} value={d.device_id}>
                          {d.device_id} ({d.category})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void handleAssign()}
                      disabled={!assignDeviceId}
                      className="h-control rounded-control bg-primary px-sm text-xs text-text-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Assign
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {mappingMode && mappedDevices.length > 0 && (
          <div className="w-72 rounded-panel border border-border bg-bg-surface1 p-md text-sm">
            <div className="mb-xs text-text-muted">Mapped ({mappedDevices.length})</div>
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {mappedDevices.map((d) => (
                <button
                  key={d.deviceId}
                  onClick={() => setSelectedNode(d.modelNode)}
                  className={`rounded-control px-xs py-0.5 text-left text-xs hover:bg-bg-surface2 ${d.modelNode === selectedNode ? "bg-bg-surface2 text-text-primary" : "text-text-secondary"}`}
                >
                  {d.deviceId} → {d.modelNode}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

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
