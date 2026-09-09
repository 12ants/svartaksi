/**
 * Owns the Svartaksi preview's react-three-fiber scene, camera, and car-driving loop.
 * Streams MapLibre live tile data into threeWorld as the camera moves, independent of
 * any physics engine — the car here is simple
 * kinematic integration (velocity/heading), not Rapier.
 *
 * `createSvartaksiRuntime` keeps the exact same imperative API it had before this file
 * became R3F-based (App.tsx and its test mock both depend on that): it mounts a
 * private React root (via ReactDOM.createRoot) into `host`, rendering a <Canvas>-based
 * scene tree, and bridges the imperative setSource/setRenderOptions/setCameraMode/
 * setTimeOfDay/teleportTo calls into it. `<Canvas>` creates its
 * WebGL context asynchronously relative to createSvartaksiRuntime returning, so those
 * setters always write into a plain mutable `control` object first (read fresh every
 * frame by useFrame, exactly like this file's pre-R3F closure variables) — once the
 * scene is actually ready it replays `control`'s current values, so nothing is lost
 * to the race regardless of call order.
 *
 * The heavy procedural world-building pipeline (threeWorld.ts/facadeRenderer.ts/
 * buildingFacade.ts) stays framework-agnostic — createThreeWorld(scene) still just
 * takes a plain THREE.Scene and self-attaches, unit-tested the same way it always
 * was — WorldScene below only calls it from inside a mount effect and drives it from
 * useFrame, rather than rewriting it as a JSX tree.
 */
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { addAfterEffect, Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraMode } from './cameraModes';
import { cameraEaseTau, DEFAULT_CAMERA_SETTINGS, type CameraSettings } from './cameraSettings';
import { rankNearbyPlaces, type NearbyItem } from './nearbyPlaces';
import { accumulateFixedSteps } from './fixedTimestep';
import { OPENING_RIDE, START_LOCATION, START_LOCATION_NAME, WORLD_DATA_RADIUS } from './config';
import { nextRideCorridorLeg, resolveBusRoute } from './busCorridor';
import { nextBlockingSignalStop, type RouteSignalStop } from './trafficLights';
import { createMapLibreProvider } from '../world/providers/maplibreProvider';
import { lookupPrecomputedArea } from '../world/providers/areaManifestCache';
import { createThreeWorld, type ThreeWorld } from '../world/threeWorld';
import {
  buildTerrainIndex,
  terrainClearanceFor,
  terrainHeightAtIndexed,
  terrainHeightAtXZIndexed,
} from '../world/terrain';
import { localToLngLat, lngLatToLocal } from '../world/geo';
import type { LngLat, LocalPoint, WorldData, WorldDataCorridor, WorldLabel, WorldRoad, WorldSource } from '../world/types';
import { roadElevationAtPoint } from '../world/roadElevationProfile';
import {
  BUS_CREEP_SPEED,
  RIDE_ARRIVAL_EPSILON,
  advanceRideSpeed,
  buildRideProfile,
  busStopDistance,
  describeInfeasibility,
  profileSpeedLimit,
  sampleRide,
  stoppingSpeedLimit,
  type RideProfile,
} from './busRouting';
import {
  DEFAULT_RENDER_OPTIONS,
  onlyWindowOptionsChanged,
  RENDER_QUALITY,
  fogDensityFor,
  resolveEffectiveRenderQuality,
  shadowQualityFor,
  type RenderOptions,
} from '../world/renderOptions';
import { setWorldTextureAnisotropy } from '../world/worldMaterials';
import { DEFAULT_TIME_OF_DAY, sceneLighting, skyState, sunOffset, SUN_DISTANCE } from '../world/timeOfDay';
import { createSkyDome, type SkyDome } from '../world/sky';
import { createRenderBudget } from '../world/renderBudget';
import {
  captureRendererIdentity,
  createPerformanceCapture,
  type PerformanceCaptureContext,
  type PerformanceCaptureSnapshot,
} from '../performance/performanceCapture';
import { shadowTexelSize, snapShadowTarget } from '../world/shadowSnap';
import { chooseRandomSpawn, isSafeSpawnPoint } from './randomSpawn';
import { loadSpawnedModel, SPAWN_FORWARD_DISTANCE, type SpawnedModel } from './spawnedModel';
import type { RemoteModel } from '../world/modelLibrary';
import {
  buildWaterIndex,
  emptyWaterIndex,
  waterDepthAtXZ,
  waterSampleAtXZ,
  type WaterIndex,
} from '../world/waterIndex';
import {
  CAR_WATER_FULL_SINK_DEPTH,
  carFootprintSamples,
  carIsSinking,
  countSubmergedSamples,
  driveControlEnabled,
  driveVelocityDamping,
  findEjectionPoint,
  initialCarWaterState,
  initialSwimBody,
  shouldEjectOccupant,
  stepCarWaterState,
  stepWaterMovement,
  settleHeight,
  SWIM_ENTER_DEPTH,
  swimBodyY,
  type CarWaterState,
} from './waterSwim';
import { INSPECTION_USER_DATA_KEY, type WorldInspectionRecord } from '../world/inspection';
import { highlightGeometryForIntersection, recordForIntersection } from './worldInspector';
import { createWorldDataCache } from '../world/worldDataCache';
import { predictStreamCenter, shouldRestream } from '../world/streamPrediction';
import {
  BUS_DOOR_BACK_Z,
  BUS_DOOR_FRONT_Z,
  BUS_FRONT_AXLE_Z,
  BUS_HALF_TRACK,
  BUS_REAR_AXLE_Z,
  BUS_WHEEL_LAYOUT,
  BUS_FLOOR_Y,
  BUS_INTERIOR_HALF_LENGTH,
  BUS_INTERIOR_HALF_WIDTH,
  BUS_MAX_STEER,
  BUS_WHEEL_RADIUS,
  BUS_WHEELBASE,
  BUS_AISLE_HALF_WIDTH,
  clampToBusFloor,
  computeRiderWorldPosition,
  applyBusShell,
  createBusModel,
  resolveAgainstBusSeats,
  setBusDisplayText,
  setBusDoorOpen,
  setBusNextStop,
  setBusNightFactor,
  setBusProximity,
  setBusSteer,
  setBusWheelRoll,
  setBusWheelTravel,
  type BusModel,
} from './busModel';
import {
  advanceBusLifecycle,
  canRelocateWorld,
  createBusLifecycle,
  type BusLifecycleState,
} from './busLifecycle';
import { sampleAlightPath } from './alightPath';
import { resolveCurrentStreet } from './currentStreet';
import { applyNightGlow, collectNightGlowMaterials } from './nightGlow';
import { applySaabShell, CAR_HALF_TRACK, CAR_HALF_WHEELBASE, createCarModel, isCarBraking, setCarLights, type CarModel } from './carModel';
import { loadSaabShell, SAAB_DIMENSIONS } from './saabModel';
import {
  advanceVehicleTransition,
  beginVehicleEntry,
  beginVehicleExit,
  type VehicleAccessPoint,
  type VehicleTransition,
} from './vehicleEntry';
import { loadBusShell, setLampIntensity, type BusShell } from './busShell';
import { createPhysicsWorld, type PhysicsWorld } from '../physics/world';
import { createPropLayer, type PropLayer } from '../physics/propLayer';
import { createBuildingLayer, type BuildingLayer } from '../physics/buildingLayer';
import { createBridgeLayer, type BridgeLayer } from '../physics/bridgeLayer';
import { createPhysicsDebugRenderer, type PhysicsDebugRenderer } from '../physics/debugRenderer';
import { createBody, updateBodyDerived, type RigidBody } from '../physics/rigidBody';
import {
  box, collider, sphere,
  CATEGORY_ALL, CATEGORY_BUILDINGS, CATEGORY_BUS, CATEGORY_PILL, CATEGORY_PROPS,
} from '../physics/types';
import type { RaycastVehicle } from '../physics/vehicle';
import { resolveCharacterMovement, resolveCharacterCeiling } from '../physics/characterController';
import {
  applyCarControls,
  createCarVehicle,
  syncCarBodyFromGroup,
  syncCarPose,
  syncCarWheels,
} from './carPhysics';
import {
  advanceBusSuspension,
  createBusSuspension,
  wheelTravel,
  type BusSuspensionState,
} from './busSuspension';
import type { TerrainClearance, TerrainIndex } from '../world/terrain';
import type { WorldProp } from '../world/propRegistry';
import { createPersonModel, PERSON_OPACITY } from './personModel';
import { loadBlobModel, type BlobModel } from './blobModel';
import { pointerViewOffset, resolveBlobbyControl } from './blobControls';
import { loadHorseModel, type HorseModel } from './horseModel';
import {
  createHorseState, canMount as canMountHorse, mount as mountHorse, dismount as dismountHorse,
  stepHorse, GAIT_SPEED_MPS, HORSE_MAX_WADE_DEPTH, type HorseState, type HorseGait,
} from './horseBody';
import {
  CAMP_LOCATION, campLayout, createCampVoices, nearestListener,
  resolveCampPoint, speak, type CampSeat, type CampVoiceState,
} from './bonfireCamp';
import { createBonfireCamp, type BonfireCampModel } from './bonfireModel';
import { createDogModel, type DogModel } from './dogModel';
import {
  createDogState, stepDog, DOG_SPAWN_LOCAL, type DogBehaviorState, type DogState, type DogStepInput,
} from './dogCompanion';
import { loadDogTrustFromStorage, saveDogTrustToStorage } from './dogTrust';
import { installDogDebugBridge, type SvartaksiDogSnapshot } from './dogDebugBridge';
import { installBusRiderDebugBridge, type SvartaksiBusRiderSnapshot } from './busRiderDebugBridge';
import { installCameraDebugBridge, type SvartaksiCameraSnapshot } from './cameraDebugBridge';
import { isDevModeRequested } from './devMode';
import { pushLog } from './gameLogger';
import {
  applyCameraSettings, clampPlacementAboveGround, pullPlacementClearOfObstruction,
  FOOT_RIG, HORSE_RIG, INTERIOR_RIG, OPENING_CAM_INTRO_DURATION_MS, resolveCameraPlacement,
  resolveOpeningIntroPlacement, VEHICLE_RIG,
} from './cameraRig';
import { createCameraTransformApplier, updateCameraFov } from './runtimeCamera';
import {
  createPlayerInputController,
  type BlobControlScheme,
  type PlayerInputSource,
  type PlayerInputState,
} from './playerInput';
import { BUS, CAMERA, CAR, CHARACTER, FREECAM, HORSE, MOVEMENT, PERSON_FADE, SHADOW, SIMULATION } from './gameplayConfig';
import { worldBuildDetails } from './worldLoadingProgress';

export interface RuntimeStatus {
  source: WorldSource;
  phase: 'loading' | 'ready' | 'error';
  mode: 'initial' | 'streaming';
  progress: number;
  message: string;
  retryable: boolean;
  details?: string[];
}

export interface SvartaksiRuntime {
  setSource(source: WorldSource): void;
  setRenderOptions(options: RenderOptions): void;
  setCameraMode(mode: CameraMode): void;
  /** The player's camera framing/feel dials — see cameraSettings.ts. Applied on the next
   * frame; nothing here rebuilds, so this is safe to call from a slider drag. */
  setCameraSettings(settings: CameraSettings): void;
  setTimeOfDay(hours: number): void;
  /** Explicit debug capture seam. It is inert unless started by a caller. */
  startPerformanceCapture(): void;
  snapshotPerformanceCapture(): PerformanceCaptureSnapshot | null;
  stopPerformanceCapture(): PerformanceCaptureSnapshot | null;
  getSpeed(): number;
  /** Where the player currently is, as lng/lat. Pulled rather than pushed — the
   * only consumer is the bus planner, which needs it once when the overlay opens,
   * so a per-frame callback would be all cost and no benefit. Before the first
   * frame runs this is START_LOCATION, which is also where the world starts. */
  getPlayerLngLat(): LngLat;
  /** The dog companion's current behavior/trust/position, for a dev-mode state readout.
   * Null before the companion has spawned. Same shape as window.__SVARTAKSI_DOG__'s
   * snapshot (see dogDebugBridge.ts) — this is the in-app counterpart of that
   * Playwright-only bridge. */
  getDogSnapshot(): SvartaksiDogSnapshot | null;
  teleportTo(lng: number, lat: number): void;
  spawnRandomPlace(): boolean;
  /** Can silently do nothing: the scene is created a microtask after
   * createSvartaksiRuntime returns (see this file's top comment), so a confirm that beats
   * scene readiness has nothing to start on, and an empty path is rejected outright.
   * Neither case is a problem for callers, because a ride that does not begin
   * announces no onMode/onCameraMode and so leaves the HUD exactly as it was. */
  startBusRide(path: LocalPoint[], signalStops?: RouteSignalStop[]): void;
  /** Requests the stop rather than performing it: the bus brakes over its own
   * stopping distance and only then sets the player down on foot, so pressing B at
   * speed does not teleport a moving vehicle to a halt. */
  stopBusRide(): void;
  /** On foot next to the car, gets in; in the car, gets out. A no-op otherwise
   * (including on foot out of range) — the runtime owns the proximity test, so
   * App.tsx never has to know where anything is. */
  toggleVehicle(): void;
  /** Parks a car within reach of the player and returns whether one is now there. The
   * world opens with no car on the road, so this is how one first appears; called again
   * later it recalls the same car rather than adding a second. False means the request
   * was refused rather than deferred — mid bus ride, already driving, or before the
   * scene exists. */
  spawnCar(): boolean;
  /**
   * Loads a GLB from the model library and stands it on the ground in front of the
   * player, facing them. Resolves to the model that was spawned, or rejects if the fetch
   * or the parse failed — a 404 from a stale catalogue entry is the expected case, and the
   * caller is expected to show it rather than swallow it.
   *
   * Spawned models are decoration: no collision frame, and a world rebuild does not remove
   * them. See spawnedModel.ts.
   */
  spawnModel(model: RemoteModel): Promise<RemoteModel>;
  /** Removes every model spawned this session, and returns how many went. */
  clearSpawnedModels(): number;
  /**
   * Tips the most recently spawned model a quarter turn about X and re-fits it, for the
   * GLBs in the library that were authored Z-up and therefore spawn on their end. Returns
   * the model that moved, or null when nothing has been spawned.
   */
  tipLastSpawnedModel(): RemoteModel | null;
  /** Swaps between 'foot' and 'blob' at the same spot, facing the same way. A no-op in
   * any other mode, and a no-op if the blob's GLB has not finished loading yet — see
   * blobModel.ts. */
  toggleBlobForm(): void;
  /** Blob mode's click-to-move: held while a pointer is down over the view, cleared on
   * release. Ignored in every other mode — the runtime does not have to be told which
   * mode is active before calling this, same as the other input setters. */
  setBlobPointer(clientX: number, clientY: number): void;
  releaseBlobPointer(): void;
  /** Swaps which input scheme drives the blob (see playerInput.ts's BlobControlScheme).
   * Takes effect on the next tick; harmless to call in any mode, including outside
   * 'blob' — it only ever affects the blob movement block. */
  setBlobControlScheme(scheme: BlobControlScheme): void;
  /** The phone's torch: one spotlight that follows the camera. Off by default and off
   * whenever the phone is shut, so it costs nothing until it is asked for. */
  setFlashlight(on: boolean): void;
  setInspectorEnabled(enabled: boolean): void;
  setInspectorPointer(clientX: number, clientY: number): void;
  retryWorldLoad(): void;
  setInputSourceState(source: PlayerInputSource, state: Partial<PlayerInputState>): void;
  releaseInputSource(source: PlayerInputSource): void;
  setInputPaused(paused: boolean): void;
  dispose(): void;
}

export interface InspectionHit extends WorldInspectionRecord {
  distanceMeters: number;
  screenX: number;
  screenY: number;
}

interface RuntimeOptions {
  host: HTMLElement;
  onStatus: (status: RuntimeStatus) => void;
  onSpeed: (speed: number) => void;
  /** Smoothed frames per second, for the HUD readout. Fired on the same slow tick as
   * speed — a per-frame number would rerender the HUD every frame to show noise. */
  onFps: (fps: number) => void;
  /** The name of wherever the player currently is — the street they are on, falling back
   * to the starting district when no named road is near. Fired only on change, so the
   * HUD can treat each one as something new to announce. */
  onArea: (area: string) => void;
  onNearby: (items: NearbyItem[]) => void;
  /** Fired on every change of what the player currently is. The runtime decides
   * some of these on its own from inside useFrame (a bus reaching the end of its
   * path sets the player down), so App.tsx cannot infer the mode from its own
   * calls alone and must not try. */
  onMode: (mode: PlayerMode) => void;
  /** Fired when the runtime changes the camera itself — boarding a bus and getting
   * off it both do. App.tsx mirrors camera mode for its panel, and this is what
   * keeps that mirror honest without polling. */
  onCameraMode: (mode: CameraMode) => void;
  /** Transient one-line HUD hint, or null to clear it. Used for the enter-the-car
   * prompt while on foot and for the bus's pulling-in state. Fired only on change. */
  onHint: (hint: string | null) => void;
  /** One line said to the player by whoever they are standing in front of, or null to
   * clear it. Separate from onHint because a hint is an instruction the HUD keeps up
   * while it applies, and this is a thing somebody said once. */
  onSpeech: (line: string | null) => void;
  onInspection: (hit: InspectionHit | null) => void;
}

export type { CameraMode } from './cameraModes';
export type { NearbyItem } from './nearbyPlaces';

function createCar(): CarModel {
  const model = createCarModel();
  model.group.userData[INSPECTION_USER_DATA_KEY] = {
    id: 'runtime:car', category: 'vehicle', title: 'Car', source: 'runtime', properties: { kind: 'car' },
  } satisfies WorldInspectionRecord;
  return model;
}

/** Shown on the front blind when the destination is not on a named road. */
const DESTINATION_FALLBACK = 'TERMINUS';
/** Shown on the saloon sign before the bus has passed anything with a name on it. */
const STREET_FALLBACK = 'UNNAMED ROAD';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * The terrain profile the physics stands on. Gated on the same `parks` toggle the renderer
 * uses, because a ground the player cannot see is worse than no ground at all: with
 * landuse switched off the car was still climbing invisible hills.
 */
function groundProfile(data: WorldData, options: RenderOptions): TerrainClearance[] {
  return terrainClearanceFor(options.parks, data.parks, options.terrain);
}

/** Scratch for the wireframe overlay's vehicle list — one entry, rebuilt in place. */
const debugVehicles: RaycastVehicle[] = [];
/**
 * Carries a rigid body along with a model the game moves itself — the bus on its route,
 * the pill on its walk controller. The body is dynamic so props feel its momentum, but it
 * is never moved *by* the solver: its pose is overwritten from the model every tick and
 * its velocity is the movement that pose implies.
 */
function carryDrivenBody(
  body: RigidBody,
  model: THREE.Object3D,
  previous: THREE.Vector3,
  dt: number,
): void {
  if (!model.visible) {
    // Parked far under the world: a hidden bus must not leave a twelve-metre invisible
    // wall standing wherever the last ride happened to end.
    body.linearVelocity.set(0, 0, 0);
    body.position.set(0, -1_000, 0);
    previous.copy(model.position);
    updateBodyDerived(body);
    return;
  }
  const moved = Math.hypot(model.position.x - previous.x, model.position.z - previous.z);
  if (moved > SIMULATION.drivenBodyTeleport) body.linearVelocity.set(0, 0, 0);
  else {
    body.linearVelocity.set(
      (model.position.x - previous.x) / dt, 0, (model.position.z - previous.z) / dt,
    );
  }
  body.position.set(model.position.x, model.position.y, model.position.z);
  body.quaternion.setFromAxisAngle(WORLD_UP, model.rotation.y);
  previous.copy(model.position);
  updateBodyDerived(body);
}

/** How close the pill must be to the car for the enter prompt to appear. */
const CAR_ENTER_RADIUS = 4.5;

/**
 * The driver's door of the Saab, in car-local metres.
 *
 * +x is the car's left (see the wheel names in carModel.ts), and this is a Swedish car in
 * Sweden, so the driver sits on the left and gets in from the left. The seat is a little
 * ahead of the body's centre and a seat's height up; the entry point is on the road
 * outside the door, level with the seat, which is where the body has to be standing
 * before any of this looks like getting into a car.
 */
const CAR_ACCESS: VehicleAccessPoint = {
  entry: new THREE.Vector3(SAAB_DIMENSIONS.width / 2 + 0.55, 0, 0.35),
  seat: new THREE.Vector3(0.38, 0.62, 0.35),
  seatYaw: 0,
  side: 1,
};
/** Height of the car's floorpan above the road it stands on, in metres. Water has to
 * reach this — not the tarmac — before the car counts as being in it, so a flooded kerb
 * or the shallow rim of a shoreline polygon does not drown a car driving past it. */
const CAR_FLOOR_HEIGHT = 0.3;
/** Nose-down attitude a fully submerged car reaches, in radians (about 14°). Positive
 * pitches the nose down in this world's convention — the same sign the bus's braking dip
 * uses — because the engine is over the front axle and that is the end that goes first. */
const SINKING_CAR_PITCH = 0.25;
/** Where the pill is put when the car it is in starts to sink: rings of candidate points
 * around the car, this many directions per ring, out to a radius past which there is
 * plainly nowhere safe and the recovery fallback takes over. */
const EJECTION_DIRECTIONS = 12;
const EJECTION_RADIUS_START = 2.6;
const EJECTION_RADIUS_STEP = 1.6;
const EJECTION_MAX_RADIUS = 14;
/** Car mode is temporarily disabled. The model remains available to the simulation's
 * shared vehicle code, but is not added to the scene and cannot be boarded. */
const CAR_ENABLED = false;
/** Keep the horse systems available without placing or loading a horse in the world. */
const HORSE_ENABLED = false;

/**
 * The phone torch. Bright enough to pick a doorway out of an unlit street, narrow enough
 * to still read as a handheld beam rather than as a second sun — and one light, because
 * every one of them is charged to every lit fragment in the scene.
 */
const FLASHLIGHT_INTENSITY = 22;
const FLASHLIGHT_REACH = 30;
const FLASHLIGHT_TAU = 0.12;

/** Exponential time constant for the door opening and closing. */
/** How far above the bus's own body a suspension corner probe still accepts a road
 * surface. Enough to take the kerb-height steps the springs exist to absorb, and well
 * under a deck's clearance, so a bus passing beneath a bridge never mistakes the deck
 * overhead for the road it is on. */
export const BUS_SUSPENSION_STEP_REACH = 0.5;

const BUS_DOOR_TAU = 0.35;

/**
 * Where the passenger sits, in the bus's local frame: back of the saloon, left
 * side (+x is left given forward = +z), eye height for someone seated on the
 * cushion at y 1.06. Sits on the rearmost row, just ahead of its cushion centre,
 * so the six rows in front are in shot and the eye clears their backrests.
 */
const BUS_SEAT_OFFSET = new THREE.Vector3(0.88, 1.85, -4.35);
/** A three.js camera looks down its own -z, the bus drives along its +z, so the
 * seat view is the bus orientation turned around. */
const BUS_SEAT_TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
/**
 * Exponential time constant, in seconds, for the body settling onto the heading its two
 * axles describe. Short, because that heading is now geometric rather than a target the
 * bus chases: all this smooths is the step from one path vertex to the next.
 */
const BUS_HEADING_TAU = 0.12;
/** How lazily the front wheels take up a new angle. An old bus has a slow steering box
 * and a driver who feeds the wheel through their hands, so the lock builds over most of
 * a second rather than arriving with the corner. */
const BUS_STEER_TAU = 0.32;
/**
 * How soft the suspension is. The body settles onto its roll and pitch far more slowly
 * than it changes course, which is what makes a long bus feel like it is carrying weight
 * rather than pivoting on the spot.
 */
const BUS_BODY_TAU = 0.5;

/** Which body the player currently is. Replaces the old riding boolean — there are
 * five states now, and "not riding" no longer implies "driving". 'blob' is a second
 * on-foot form (see blobModel.ts): its own body, its own pace, no vehicle or camp
 * interactions — a toggle between two ways to walk around, not a fourth mode fully
 * wired into everything 'foot' does. 'horse' is a genuine vehicle mode alongside 'car'
 * (see horseBody.ts): mounted/dismounted by proximity through the same E key. */
export type PlayerMode = 'car' | 'bus' | 'foot' | 'blob' | 'horse';

/** Flat background/fog color at a neutral time of day — immediately overwritten by
 * applyTimeOfDay(DEFAULT_TIME_OF_DAY) once the scene is ready, same as before. */
const FOG_COLOR = 0x91aeb7;
/**
 * Starting fog density, replaced by fogDensityFor the moment render options are applied.
 * Buildings are hard-cut at their draw distance and fog is what hides the cut, so the
 * density is derived from that distance rather than fixed — which also means a machine
 * that falls behind and has its draw distance pulled in gets thicker fog to match,
 * instead of watching buildings vanish out of clear air. See fogDensityFor.
 */
const FOG_DENSITY = fogDensityFor(RENDER_QUALITY.balanced.buildingDistance);
/** How quickly the fog moves to a new density, in seconds. The render budget steps in
 * jumps; sliding the haze across a couple of seconds keeps that from reading as the
 * weather changing on a cut. */
const FOG_TAU = 1.6;

/**
 * How far either side of the sun's target the shadow camera has to reach: the widest
 * shadow frustum extent (150) plus headroom for the tallest building that can stand at
 * its edge. Applied as near/far around SUN_DISTANCE — the OrthographicCamera defaults
 * (0.5 / 500) spread the depth range over roughly ten times the slab that actually
 * holds geometry, and every bit of that unused range is depth-buffer precision the
 * shadow comparison does not get to use.
 */
const SHADOW_CAMERA_HALF_DEPTH = 280;
const SHADOW_CAMERA_NEAR = Math.max(1, SUN_DISTANCE - SHADOW_CAMERA_HALF_DEPTH);
const SHADOW_CAMERA_FAR = SUN_DISTANCE + SHADOW_CAMERA_HALF_DEPTH;

/**
 * Plain mutable state shared between the imperative SvartaksiRuntime API (called from
 * App.tsx, outside React) and the R3F scene tree mounted inside it. Deliberately not
 * React state for these fields — they're read fresh every frame inside useFrame,
 * exactly like the plain closure variables this file used before it was R3F-based, so
 * a setter never has to trigger a React re-render just to change what next frame's
 * physics/camera update reads.
 */
interface RuntimeControl {
  source: WorldSource;
  renderOptions: RenderOptions;
  cameraMode: CameraMode;
  camera: CameraSettings;
  timeOfDay: number;
  speed: number;
  /** Local-meter position of whichever body the player currently is — car, pill, or
   * bus. Written once per frame alongside `speed`; `getPlayerLngLat` reads it. */
  position: LocalPoint;
  /** What the player currently is. App.tsx keeps its own mirror of this rather than
   * reading it: every transition is announced through onMode, so there is no polling. */
  mode: PlayerMode;
  /** Mirrors dogStateRef every frame the companion is stepped, so getDogSnapshot() can
   * read it synchronously the same way getSpeed()/getPlayerLngLat() read control. */
  dog: SvartaksiDogSnapshot | null;
  inspectorEnabled: boolean;
  /** Whether the phone's torch is lit. */
  flashlight: boolean;
  inspectorPointer: { x: number; y: number } | null;
  inspectorPending: boolean;
  /** Client-space position of a held pointer drag, or null while nothing is held. Blob
   * mode's click-to-move (see blobby's own "mouse hold + move" control) reads this —
   * every other mode ignores it. */
  blobPointer: { x: number; y: number } | null;
  /** Which input scheme drives the blob (see playerInput.ts). Read fresh every tick by
   * the blob movement block, same plain-mutable-field pattern as every other control. */
  blobControlScheme: BlobControlScheme;
  input: ReturnType<typeof createPlayerInputController>;
  inputPaused: boolean;
}

/**
 * Imperative operations WorldScene exposes back to createSvartaksiRuntime once the R3F
 * Canvas/scene actually exist. Each SvartaksiRuntime setter always writes into `control`
 * first regardless of whether this is available yet; once it becomes available,
 * whatever's currently in `control` is replayed once — see this file's top comment.
 */
interface SceneApi {
  applySource(source: WorldSource): void;
  applyRenderOptions(options: RenderOptions): void;
  applyTimeOfDay(hours: number): void;
  applyTeleport(lng: number, lat: number): void;
  applySpawnRandomPlace(): boolean;
  applyStartBusRide(path: LocalPoint[], signalStops?: RouteSignalStop[]): void;
  applyStopBusRide(): void;
  applyToggleVehicle(): void;
  applySpawnCar(): boolean;
  applySpawnModel(model: RemoteModel): Promise<RemoteModel>;
  applyClearSpawnedModels(): number;
  applyTipLastSpawnedModel(): RemoteModel | null;
  applyToggleBlobForm(): void;
  retryWorldLoad(): void;
  startPerformanceCapture(): void;
  snapshotPerformanceCapture(): PerformanceCaptureSnapshot;
  stopPerformanceCapture(): PerformanceCaptureSnapshot;
}

/** Keeps an imperative debug-capture request made before Canvas has produced its API. */
export function createDeferredPerformanceCaptureStart() {
  let requested = false;
  return {
    request(startNow?: () => void) {
      requested = true;
      startNow?.();
    },
    clear() {
      requested = false;
    },
    replay(start: () => void) {
      if (requested) start();
    },
  };
}

const VISIBILITY_CHECK_INTERVAL_MS = 250;
/**
 * Milliseconds per frame handed to the world's incremental builder. A 60fps frame is
 * 16.7ms and this scene's own draw already spends most of it, so the budget is the
 * slack: enough that a streamed world lands within a second or two of its data
 * arriving, small enough that the frame it lands in is not visibly longer than its
 * neighbours. The builder always completes at least one slice per call, so a single
 * slow slice can overshoot this — the chunk sizes in threeWorld are picked to keep
 * that overshoot sub-millisecond.
 */
const WORLD_BUILD_BUDGET_MS = 4;
/**
 * Budget per tick while the first world builds behind the loading curtain.
 *
 * This runs off a timer rather than the render loop, and that is the whole point. A
 * per-frame budget ties build throughput to frame rate, which is exactly backwards for
 * the opening load: the machines that render slowest are the ones that would then also
 * assemble the world slowest, so the wait compounds. Measured headless with software
 * WebGL (a few frames a second), a frame-driven build spent the better part of a minute
 * on a world a timer-driven one finishes in seconds. Nothing is on screen but a CSS
 * animation, so the frame owes the build everything it has.
 *
 * This also replaced a `scheduler.flush()` on the first load, which ran the entire build
 * in one synchronous call: a multi-second unresponsive tab with no paint, no progress,
 * and no way to tell whether it had hung. Yielding to the event loop between ticks is
 * what keeps the curtain animating and the page interactive.
 *
 * Sized to leave real headroom rather than to take everything. At 24ms the loop ran
 * back-to-back long tasks and left a software-rendered browser (headless swiftshader, as
 * the screenshot script and e2e both use) nothing to work with — observed crashing the
 * page part-way through the build. 12ms still buys an order of magnitude over
 * frame-gating on a slow renderer, and the compositor still gets its turn.
 */
const CURTAIN_BUILD_BUDGET_MS = 12;
/** How often the loading curtain's progress is refreshed while the world assembles.
 * Per-frame updates would re-render the HUD sixty times a second to move a bar by
 * fractions of a percent. */
const BUILD_PROGRESS_INTERVAL_MS = 120;
/** Share of the loading bar given to fetching and decoding; the rest is the build.
 * Roughly how the two split in practice on a cold start. */
const FETCH_PROGRESS_SHARE = 0.4;

const STREAM_CHECK_INTERVAL_MS = 1_000;
const STREAM_RESTREAM_DISTANCE = 520;
/** How far the bus has to travel since the last route-corridor fetch before the next leg
 * is due. Kept well under BUS_CORRIDOR_LOOKAHEAD_METERS so the next leg is always fetched
 * with plenty of the current one still unconsumed ahead of the bus. */
const BUS_CORRIDOR_RESTREAM_METERS = 1_200;
/** How far ahead of the bus each fetched corridor leg reaches. Comfortably past
 * WORLD_DATA_RADIUS.terrain so a long ride actually finds new ground, not data the
 * initial disc load already covered. */
const BUS_CORRIDOR_LOOKAHEAD_METERS = 2_400;
/** Half-width of the fetched ribbon on each side of the route line, in metres. Matches
 * WORLD_DATA_RADIUS.buildings so nothing near the ribbon's edge is tile-starved: the
 * building keep-radius below is measured against this same width. */
export const BUS_CORRIDOR_PAD_METERS = WORLD_DATA_RADIUS.buildings;
const WORLD_CACHE_GRID_DEGREES = 0.002;

export function worldCacheKey(
  source: WorldSource,
  center: { lng: number; lat: number },
  corridor?: WorldDataCorridor,
): string {
  const quantize = (value: number) =>
    Math.round(value / WORLD_CACHE_GRID_DEGREES) * WORLD_CACHE_GRID_DEGREES;
  const key: Array<string | number> = [
    source,
    quantize(center.lng).toFixed(3),
    quantize(center.lat).toFixed(3),
    WORLD_DATA_RADIUS.buildings,
    WORLD_DATA_RADIUS.terrain,
  ];
  // A corridor fetch covers a ribbon, not the disc the rest of this key describes — keyed
  // separately so a coincidental quantized-centre match with an unrelated disc load can
  // never serve the wrong shape of data back to either caller.
  if (corridor) {
    key.push(
      'corridor',
      quantize(corridor.from.lng).toFixed(3),
      quantize(corridor.from.lat).toFixed(3),
      corridor.padMeters,
    );
  }
  return key.join(':');
}

/**
 * Resolves the WorldData for one loadWorld request: a shipped area precomputed by
 * scripts/prefetch-world.mjs skips fetch, decode and normalize entirely.
 * lookupPrecomputedArea never throws — a miss of any kind (no manifest, no matching
 * key, an origin mismatch) falls through to the live provider exactly as if this call
 * weren't here. Extracted from loadWorld so it can be exercised directly in tests,
 * which don't mount the real Canvas/WorldScene tree loadWorld otherwise lives inside.
 */
export async function resolveWorldData(
  cacheKey: string,
  center: LngLat,
  signal: AbortSignal,
  corridor: WorldDataCorridor | undefined,
): Promise<WorldData> {
  const precomputed = await lookupPrecomputedArea(cacheKey, START_LOCATION, signal);
  const provider = createMapLibreProvider();
  const data = precomputed
    ?? await provider.load(center, WORLD_DATA_RADIUS, signal, START_LOCATION, corridor, 'foreground');
  if (data.roads.length + data.buildings.length <= 8) {
    throw new Error('World source returned insufficient map data');
  }
  return data;
}

function WorldScene({
  control,
  callbacks,
  onReady,
  setShadowsEnabled,
}: {
  control: RuntimeControl;
  callbacks: Pick<RuntimeOptions, 'onStatus' | 'onSpeed' | 'onFps' | 'onArea' | 'onNearby' | 'onMode' | 'onCameraMode' | 'onHint' | 'onSpeech' | 'onInspection'>;
  onReady: (api: SceneApi) => void;
  setShadowsEnabled: (enabled: boolean) => void;
}) {
  const { scene, gl } = useThree();

  // Latest-value ref mirrors for callback props read from inside the mount-once
  // effect/useFrame below — kept current via an effect (not during render) so
  // WorldScene never has to depend on (or re-run its one-time setup for) a prop
  // identity change.
  const onReadyRef = useRef(onReady);
  const callbacksRef = useRef(callbacks);
  const setShadowsEnabledRef = useRef(setShadowsEnabled);
  // `control` is the same mutable object for a runtime's whole lifetime, but the
  // mount-once effect below must not take it as a dependency — mirror it like the
  // callback props so the effect keeps its [scene, gl] deps.
  const controlRef = useRef(control);
  useEffect(() => {
    onReadyRef.current = onReady;
    callbacksRef.current = callbacks;
    setShadowsEnabledRef.current = setShadowsEnabled;
    controlRef.current = control;
  }, [onReady, callbacks, setShadowsEnabled, control]);

  const sunRef = useRef<THREE.DirectionalLight>(null!);
  const ambientRef = useRef<THREE.HemisphereLight>(null!);
  const carRef = useRef<THREE.Group | null>(null);
  const carModelRef = useRef<CarModel | null>(null);
  /** Held only so the modelled bus body can be freed on teardown; nothing reads it. */
  const busShellRef = useRef<BusShell | null>(null);
  /**
   * The get-in/get-out sequence, while one is running. Non-null means the pill's pose is
   * the state machine's to write and the player's input is only consulted for whether
   * they have changed their mind — see the vehicleEntry block in the frame loop.
   */
  const carTransitionRef = useRef<VehicleTransition | null>(null);
  /**
   * Whether a car is actually standing in the world. CAR_ENABLED is only the opening
   * state of this — the start is a bare stretch of motorway with no vehicle on it — and
   * the spawn-car action flips it on for the rest of the session. Boarding and the enter
   * prompt read this rather than the constant, so neither can offer a car that is not
   * there to get into.
   */
  const carSpawnedRef = useRef(CAR_ENABLED);
  /** Latest time-of-day night factor, mirrored out of applyTimeOfDay so the frame loop
   * can drive the car's lamps without recomputing the sky. */
  const nightFactorRef = useRef(0);
  const worldRef = useRef<ThreeWorld | null>(null);
  /** The rigid-body simulation everything physical in this scene lives in. */
  const physicsRef = useRef<PhysicsWorld | null>(null);
  const carVehicleRef = useRef<RaycastVehicle | null>(null);
  /**
   * The bus and the pill are *positionally driven* bodies: their pose comes from the
   * route and from the walk controller respectively, and is written into the body each
   * tick along with the velocity implied by how far it moved. They therefore shove things
   * with the right momentum without the solver ever being allowed to push them back —
   * their pose is re-asserted after every step. A bus that could be knocked off its route
   * by a post box is not a bus anyone can ride.
   */
  const busBodyRef = useRef<RigidBody | null>(null);
  const personBodyRef = useRef<RigidBody | null>(null);
  const previousBusPointRef = useRef(new THREE.Vector3());
  const previousPersonPointRef = useRef(new THREE.Vector3());
  const busSuspensionRef = useRef<BusSuspensionState>(createBusSuspension());
  /** Body attitude from load transfer only — cornering lean and brake dive. Held apart
   * from `bus.rotation` because the terrain suspension is added on top of it, and reading
   * the sum back as the previous frame's lean would compound the two. */
  const busLeanRef = useRef({ pitch: 0, roll: 0 });
  const busWheelTravelRef = useRef<number[]>([]);
  const propLayerRef = useRef<PropLayer | null>(null);
  const buildingLayerRef = useRef<BuildingLayer | null>(null);
  const bridgeLayerRef = useRef<BridgeLayer | null>(null);
  const physicsDebugRef = useRef<PhysicsDebugRenderer | null>(null);
  /** Landuse extrusion profile of the current snapshot, which is what the physics world
   * reads the ground height out of. Refreshed whenever world data arrives. */
  const terrainClearanceRef = useRef<TerrainClearance[]>([]);
  /** Spatial index (backlog item 3) over terrainClearanceRef's current array, rebuilt in
   * lockstep with it. The physics ground callback and the bus/on-foot corner probes run
   * every physics tick — a couple of hundred queries a tick per the terrain.ts comment —
   * so they read this instead of rescanning every landuse polygon per query. */
  const terrainIndexRef = useRef<TerrainIndex>(buildTerrainIndex([]));
  /** Which water polygon (if any) covers a given point, and how high its sheet is drawn.
   * Rebuilt in lockstep with terrainIndexRef, because the height it stores is derived from
   * that terrain — see waterIndex.ts. Read by the pill (once a tick) and the car (five
   * footprint samples a tick). */
  const waterIndexRef = useRef<WaterIndex>(emptyWaterIndex());
  /** Swimming state per playable on-foot body: whether it is currently swimming, and the
   * stroke velocity it carries between ticks. See waterSwim.ts's SwimBody. */
  const personSwimRef = useRef(initialSwimBody());
  const blobSwimRef = useRef(initialSwimBody());
  /** How far through drowning the car is (backlog item 10). Advanced every fixed tick
   * whether or not anyone is at the wheel: a car pushed into the water, or abandoned in
   * it, sinks the same way one that was driven in does. */
  const carWaterRef = useRef<CarWaterState>(initialCarWaterState());
  /** Water surface the sinking car is measured down from — latched when it first goes
   * under rather than re-read while sinking, so the car keeps descending from one datum
   * instead of chasing whichever polygon it happens to drift over. */
  const carSinkSurfaceRef = useRef(0);
  /** Models spawned from the library this session (see spawnedModel.ts). Decoration, not
   * world data: a rebuild leaves them alone, so the runtime holds them itself. */
  const spawnedModelsRef = useRef<SpawnedModel[]>([]);
  /** Identity of the prop set the physics layer is currently holding, so a rebuilt world
   * is noticed without threeWorld having to announce it. */
  const adoptedPropsRef = useRef<WorldProp[] | null>(null);
  const skyDomeRef = useRef<SkyDome | null>(null);
  const sunOffsetVecRef = useRef(new THREE.Vector3());
  const renderBudgetRef = useRef(createRenderBudget());
  const performanceCaptureRef = useRef(createPerformanceCapture());
  const worldDataCacheRef = useRef(createWorldDataCache());
  const [applyCameraTransform] = useState(createCameraTransformApplier);

  // Car-physics/camera state — plain refs, mutated every frame, not React state.
  const velocityRef = useRef(0);
  const brakingRef = useRef(false);
  const headingRef = useRef(0);
  /** Real time banked but not yet spent on a fixed simulation tick. See
   * accumulateFixedSteps and SIMULATION.fixedDt. */
  const simAccumulatorRef = useRef(0);
  const busRef = useRef<THREE.Group | null>(null);
  const busModelRef = useRef<BusModel | null>(null);
  const busLifecycleRef = useRef<BusLifecycleState>(createBusLifecycle());
  const busPathRef = useRef<LocalPoint[] | null>(null);
  const busProfileRef = useRef<RideProfile | null>(null);
  const busTraveledRef = useRef(0);
  const busSpeedRef = useRef(0);
  /** Cumulative wheel roll, radians — distance / BUS_WHEEL_RADIUS integrated every frame
   * the bus is moving. Unbounded rather than wrapped to 2π: THREE reduces it internally
   * for rendering, and there is no other reader that would care about the raw value. */
  const busWheelRollRef = useRef(0);
  /** Distance along the path the bus is braking toward, or null while it is just
   * running the route. Set by a stop request; cleared when the ride ends. */
  const busStopAtRef = useRef<number | null>(null);
  /** Every signalised approach the current route crosses, in path order. Checked afresh
   * each tick against the live clock rather than cached as blocked/clear, since a red the
   * bus is braking for can turn green again before it arrives. */
  const busSignalStopsRef = useRef<RouteSignalStop[]>([]);
  const busDoorOpenRef = useRef(false);
  /** How far the doors have actually swung, 0 shut to 1 open. The lifecycle reads it to
   * know when boarding may start, so it is the animation's state rather than a value
   * recovered from a transform. */
  const busDoorFractionRef = useRef(0);
  /** Front-wheel lock, radians, positive to the left. */
  const busSteerRef = useRef(0);
  const lastBusDisplayAtRef = useRef(0);
  const personRef = useRef<THREE.Group | null>(null);
  const personMaterialsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const personHeadingRef = useRef(0);
  /** 0..1 fade-in progress for every appearance of the pill. */
  const personFadeRef = useRef(0);
  /** Jump/gravity/climb state for the on-foot pill — see gameplayConfig.CHARACTER and
   * the vertical-motion block in the fixed-tick loop. */
  const personVerticalRef = useRef({ verticalVelocity: 0, grounded: true });
  const blobRef = useRef<THREE.Group | null>(null);
  const blobHeadingRef = useRef(0);
  /** 'blobby' scheme only (see BLOBBY in gameplayConfig.ts and playerInput.ts's
   * BlobControlScheme): the camera's own orbit yaw around the blob, independent of
   * which way the blob model itself is facing — mirrors the container/character split
   * in docs/misc/blobby's CharacterController.jsx, without needing a matching Object3D
   * hierarchy change here. */
  const blobCameraYawRef = useRef(0);
  /** 'blobby' scheme only: the blob's facing, expressed relative to blobCameraYawRef —
   * blobby's own characterRotationTarget. Retained (not reset) whenever there is no
   * movement input, same as the ref it is ported from. */
  const blobFacingOffsetRef = useRef(0);
  /** Detects a scheme switch (including the transition into 'blob' mode) so the camera
   * orbit yaw can be resynced to the blob's current facing instead of snapping the view
   * on the first frame under the new scheme. */
  const blobLastSchemeRef = useRef<BlobControlScheme>('direct');
  /** Same as personVerticalRef, for the blob. */
  const blobVerticalRef = useRef({ verticalVelocity: 0, grounded: true });
  /** Set once loadBlobModel resolves and its group has been parented in — toggling into
   * 'blob' mode before then would show an empty group standing at the origin. */
  const blobReadyRef = useRef(false);
  const blobModelRef = useRef<BlobModel | null>(null);
  const horseRef = useRef<THREE.Group | null>(null);
  /** Set once loadHorseModel resolves and its group has been parented in — same
   * load-race guard as blobReadyRef. */
  const horseReadyRef = useRef(false);
  const horseModelRef = useRef<HorseModel | null>(null);
  /** The horse's own gait/turn state (see horseBody.ts) — physics-free, driven directly
   * by rider input while mounted and left standing still otherwise. */
  const horseStateRef = useRef<HorseState>(createHorseState(0, 0));
  /** True while the pill is aboard the bus: it stands on the saloon floor and the
   * shell is solid to it except through the open doorway. */
  const insideBusRef = useRef(false);
  /** Rider's position within the bus cabin, in bus-local coordinates, while riding. */
  const riderLocalOffsetRef = useRef<{ x: number; z: number }>({ x: BUS_SEAT_OFFSET.x, z: BUS_SEAT_OFFSET.z });
  /** Frozen cabin-local start of the active alight path. Without this, the animation's
   * first tick jumped back to the authored seat even when the rider walked elsewhere. */
  const alightStartLocalRef = useRef<{ x: number; z: number }>({ x: BUS_SEAT_OFFSET.x, z: BUS_SEAT_OFFSET.z });
  const walkCycleRef = useRef(0);
  // Last hint pushed to the HUD, so the per-frame proximity test only calls back
  // when the answer actually changes rather than 60 times a second.
  const hintRef = useRef<string | null>(null);
  const setHintRef = useRef<(hint: string | null) => void>(() => {});
  /** The camp in the woods, its per-pill line counters, and which pill (if any) is
   * currently close enough to talk to. The camp is built once and left standing: it is
   * one fixed place in the world, not something the stream produces. */
  const campRef = useRef<BonfireCampModel | null>(null);
  const campSeatsRef = useRef<CampSeat[]>([]);
  const dogModelRef = useRef<DogModel | null>(null);
  const initialDogState: DogState = {
    ...createDogState(DOG_SPAWN_LOCAL.x, DOG_SPAWN_LOCAL.z),
    ...loadDogTrustFromStorage(window.localStorage),
  };
  const dogStateRef = useRef<DogState>(initialDogState);
  /** Last behavior a dev-mode log line was written for, so the state log gets one entry
   * per transition (stalking → wary → …) instead of one every frame. */
  const dogLoggedBehaviorRef = useRef<DogBehaviorState>(initialDogState.behavior);
  const campVoicesRef = useRef<CampVoiceState[]>(createCampVoices());
  const campListenerRef = useRef(-1);
  /** Re-seats the camp on the terrain of a freshly arrived snapshot. Held in a ref
   * because the loader closure is created before the scene is. */
  const placeCampRef = useRef<(data: WorldData) => void>(() => {});
  const sayRef = useRef<(line: string) => void>(() => {});
  const setModeRef = useRef<(mode: PlayerMode) => void>(() => {});
  // Lets useFrame (a sibling hook, outside the mount effect setCamera is defined in)
  // trigger the auto-switch into cockpit view once the opening intro finishes.
  const setCameraRef = useRef<(mode: CameraMode) => void>(() => {});
  // useFrame needs to set the player down on arrival, but the alight closure is
  // created inside the mount effect — same indirection loadWorldRef already uses.
  const alightRef = useRef<() => void>(() => {});
  /** Puts the player out of a car that has started to sink. Same indirection as alightRef:
   * useFrame decides when it happens, the mount effect owns the scene objects it needs. */
  const ejectFromSinkingCarRef = useRef<() => void>(() => {});
  const freecamPositionRef = useRef(new THREE.Vector3());
  const freecamYawRef = useRef(0);
  const freecamPitchRef = useRef(0);
  /** Set when freecam is entered, cleared by the first freecam frame, which is the only
   * place with a camera to copy — see the seeding block in useFrame. */
  const freecamSeedPendingRef = useRef(true);
  /** When the current camera mode was entered, in the same clock `time` is measured on.
   * Orbit is defined relative to that moment rather than to the world clock, so it starts
   * behind the body instead of at whatever bearing the session had reached; anything else
   * that ever needs "how long have we been in this mode" reads the same ref rather than
   * growing a second one. */
  const cameraModeEnteredMsRef = useRef(0);
  const lastCameraModeRef = useRef<CameraMode | null>(null);
  /**
   * The one answer to "what is the surface here": the physics ground callback once the
   * world has built one — terrain plus every road deck, which is what a vehicle is
   * grounded on — and the terrain index alone before that exists.
   *
   * Stable across renders and defined once rather than per frame, since the camera asks it
   * every frame. Four older call sites in this file still spell the same fallback out
   * inline; they predate this and are left alone rather than widening the change.
   */
  /**
   * Distance from a camera's look target to the first solid thing along its sightline, or
   * null when the line is clear — what `pullPlacementClearOfObstruction` needs to shorten
   * a boom that would otherwise leave the camera inside a building or a tree.
   *
   * A physics raycast rather than a height sample, because the question is genuinely
   * "is something in the way", which a height under the camera cannot answer: a camera
   * standing inside a wall is still comfortably above the floor beneath it.
   *
   * Cast from the target outward rather than from the camera inward, so the *nearest*
   * obstruction to the player is the one honoured. Casting the other way would find the
   * far side of a wall the camera is already behind and happily leave it there.
   */
  const cameraSightlineHit = useCallback((
    fromX: number, fromY: number, fromZ: number,
    dirX: number, dirY: number, dirZ: number,
    maxDistance: number,
  ): number | null => {
    const physics = physicsRef.current;
    if (!physics) return null;
    const hit = physics.raycast(
      new THREE.Vector3(fromX, fromY, fromZ),
      new THREE.Vector3(dirX, dirY, dirZ),
      maxDistance,
      null,
      // Buildings and props only. The ray starts inside the body the camera is framing,
      // so anything that can be a *subject* — the car, the pill, the bus — would be hit
      // at zero distance and collapse every shot onto its own target. Restricting the
      // mask says what is actually meant: a camera is blocked by the world, never by
      // what it is looking at.
      CATEGORY_BUILDINGS | CATEGORY_PROPS,
    );
    return hit ? hit.distance : null;
  }, []);
  const groundHeightAt = useCallback((x: number, z: number, maxHeight = Infinity) => (physicsRef.current
    ? physicsRef.current.groundHeightAt(x, z, maxHeight)
    : terrainHeightAtXZIndexed(x, z, terrainIndexRef.current)), []);
  /**
   * The counterparts for water. `waterSurfaceAt` is the height the sheet is drawn at, or
   * null where no water polygon covers the point; `waterBedAt` is the surface a body
   * standing there would be standing on — the deeper of the real terrain and the implied
   * shelving bed (see waterIndex.ts's WATER_OPEN_DEPTH), which on dry land is just the
   * ground. Both stable and defined once, for the same reason `groundHeightAt` is.
   */
  const waterSurfaceAt = useCallback(
    (x: number, z: number) => waterSampleAtXZ(x, z, waterIndexRef.current)?.surface ?? null,
    [],
  );
  const waterDepthAt = useCallback(
    (x: number, z: number) => waterDepthAtXZ(x, z, waterIndexRef.current),
    [],
  );
  /**
   * Everything a playable body needs to know about the surface at (x, z): the height it
   * would stand on, and the water surface over it if there is one.
   *
   * The two are asked together because they are one answer, and the swim decision is the
   * gap between them. Inside a water polygon the standing height is the *implied bed*
   * (waterIndex.ts) rather than the physics ground: the physics ground is the same flat
   * plane the streets are on, two centimetres under the sheet, so reading it there would
   * make every lake in the city ankle-deep and nothing would ever swim. The bed rises to
   * meet the surface — and therefore the land — at the shoreline, so the two agree
   * exactly where they meet.
   *
   * That does put a wading body below the rendered ground plane, which is what makes it
   * disappear from the feet up as it walks out: the plane occludes it in place of the
   * beach this world has no geometry for.
   */
  const surfaceUnderBody = useCallback((x: number, z: number, feetY = Infinity) => {
    const water = waterSampleAtXZ(x, z, waterIndexRef.current);
    const ground = groundHeightAt(x, z, feetY + 0.3);
    if (!water || ground > water.surface + 0.1) return { standY: ground, waterY: null as number | null };
    return { standY: water.surface - water.depth, waterY: water.surface };
  }, [groundHeightAt]);
  const nightGlowMaterialsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const shadowTexelRef = useRef(0);
  const flashlightRef = useRef<THREE.SpotLight | null>(null);
  const flashlightAimRef = useRef(new THREE.Vector3());
  /** Where the fog is heading, derived from the effective building draw distance. The
   * scene's own density eases toward it — see FOG_TAU. */
  const fogDensityTargetRef = useRef(FOG_DENSITY);
  const shadowTargetRef = useRef(new THREE.Vector3());
  /** Scratch for the snapped candidate target, reused so the "did it move enough to
   * matter" check below doesn't allocate every frame. */
  const shadowCandidateRef = useRef(new THREE.Vector3());
  /** Baking: renderer.shadowMap.autoUpdate is off (see Canvas onCreated), so nothing
   * re-renders the shadow map unless this is true for at least one frame. Starts true
   * so the very first frame still gets a shadow pass. Set whenever something that
   * actually invalidates the map happens — see applyTimeOfDay, applyRenderOptions, and
   * the recentre check in useFrame. */
  const shadowNeedsUpdateRef = useRef(true);
  /** Last frame's world.isBuilding(), so a rebuild finishing (streamed geometry settling
   * within shadow range) still forces one more shadow update on its falling edge instead
   * of freezing the map mid-transition. */
  const shadowStreamingRef = useRef(false);
  /** Last frame's pill shadow-casting state (see PERSON_FADE.shadowFade below) — flipping
   * castShadow on a mesh changes what the baked shadow map should contain even when the
   * frustum itself hasn't moved. */
  const personCastsShadowRef = useRef(false);
  const fpsRef = useRef(0);
  const lastAreaRef = useRef<string | null>(null);
  const keysRef = useRef(new Set<string>());
  const labelsRef = useRef<WorldLabel[]>([]);
  const currentDataRef = useRef<WorldData | null>(null);
  const activeSourceRef = useRef<WorldSource>('maplibre');
  /** Where the player stood when the world was last streamed — the point travel is
   * measured from. Distinct from the centre that stream was aimed at (below). */
  const streamAnchorRef = useRef(new THREE.Vector2(0, 0));
  /** Where the last stream was centred: the look-ahead point at the moment it was
   * requested, and so the centre of the data currently loaded. */
  const streamedCenterRef = useRef(new THREE.Vector2(0, 0));
  const lastStreamCheckRef = useRef(0);
  const lastVisibilityCheckRef = useRef(0);
  const generationRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const disposedRef = useRef(false);
  const loadWorldRef = useRef<(
    source: WorldSource,
    center: { lng: number; lat: number },
    streaming: boolean,
    corridor?: WorldDataCorridor,
  ) => void>(() => {});
  const lastLoadRef = useRef<{
    source: WorldSource;
    center: { lng: number; lat: number };
    streaming: boolean;
    corridor?: WorldDataCorridor;
  } | null>(null);
  const pendingReadyRef = useRef<{ request: number; status: RuntimeStatus } | null>(null);
  const worldReadyRef = useRef(false);
  const lastBuildProgressAtRef = useRef(0);
  /**
   * The opening ride runs exactly once per runtime, whatever happens to it: 'pending'
   * until the first world is on screen, 'running' while the route is being resolved,
   * 'done' from the moment the player is aboard — or from the moment the attempt fails,
   * so a network hiccup at startup does not re-trigger it on the next streamed world.
   */
  const openingRidePhaseRef = useRef<'pending' | 'running' | 'done'>('pending');
  const openingCamStartMsRef = useRef<number | null>(null);
  // Whether the auto-switch into cockpit view at the end of the opening intro has
  // already fired for the current ride — set back to false each time a new intro
  // starts (see beginOpeningRide), so it fires exactly once per ride.
  const introCockpitAppliedRef = useRef(false);
  const openingRideControllerRef = useRef<AbortController | null>(null);
  /** Handle for the curtain's timer-driven build loop, 0 when it is not scheduled. */
  const curtainPumpTimerRef = useRef(0);
  /** Returns true if it took ownership of the loading curtain — see its definition. */
  const beginOpeningRideRef = useRef<(readyStatus: RuntimeStatus) => boolean>(() => false);
  /** Test-only seam (see busRiderDebugBridge.ts): starts a bus ride along a road already
   * present in the loaded world data, bypassing the opening ride's own corridor fetch
   * and long-distance pathfinding. Only reachable through the ?dev=1-gated debug bridge,
   * never from normal play. Returns true if it managed to board. */
  const debugBoardBusRef = useRef<() => boolean>(() => false);
  const debugMoveWorldRef = useRef<(x: number, z: number) => boolean>(() => false);
  /** Last street name the bus resolved. Held so the saloon sign shows the road it is on
   * rather than blanking to a placeholder every time the bus passes between two label
   * points, which on a long way is most of the time. */
  const lastBusStreetRef = useRef<string | null>(null);
  /** Same, for the destination blind on the front of the bus. */
  const lastBusDestinationRef = useRef<string | null>(null);
  const preloadControllerRef = useRef<AbortController | null>(null);
  const lastPreloadKeyRef = useRef('');
  /** Traveled distance the last bus-route corridor leg was fetched from — see
   * nextRideCorridorLeg. Reset on every new ride so its first leg fetches promptly
   * rather than inheriting a huge "already covered" distance from the previous one. */
  const busCorridorFetchedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const raycasterRef = useRef(new THREE.Raycaster());
  const inspectPointerRef = useRef(new THREE.Vector2());
  const lastInspectionAtRef = useRef(0);
  const lastInspectionKeyRef = useRef('');
  const inspectionHighlightRef = useRef<THREE.Mesh | null>(null);

  // Read once: this effect runs only at mount, and re-checking the URL on every
  // render would be pointless work for a flag that cannot change without a reload.
  const devMode = isDevModeRequested(window.location.search);

  useEffect(() => {
    const worldDataCache = worldDataCacheRef.current;
    scene.background = new THREE.Color(FOG_COLOR);
    scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    const carModel = createCar();
    const car = carModel.group;
    carRef.current = car;
    carModelRef.current = carModel;
    if (carSpawnedRef.current) {
      scene.add(car);
      if (devMode) pushLog('info', 'load', 'car model ready');
    }

    const busModel = createBusModel();
    const { group: bus } = busModel;
    busModelRef.current = busModel;
    bus.userData[INSPECTION_USER_DATA_KEY] = {
      id: 'runtime:bus', category: 'vehicle', title: 'Bus', source: 'runtime', properties: { kind: 'bus' },
    } satisfies WorldInspectionRecord;
    bus.visible = false;
    busRef.current = bus;
    scene.add(bus);
    if (devMode) pushLog('info', 'load', 'bus model ready');

    // The modelled body arrives a beat after the procedural one, and replaces its skin
    // (busShell.ts). Until then — and forever, if the asset cannot be fetched — the bus is
    // the procedural shell, which is a whole bus rather than a placeholder, so there is
    // nothing to hide and no loading state to wait on.
    loadBusShell().then((shell) => {
      if (disposedRef.current) {
        shell.dispose();
        return;
      }
      applyBusShell(busModel, shell);
      busShellRef.current = shell;
      if (devMode) pushLog('info', 'load', 'bus shell model ready');
    }).catch((error: unknown) => {
      console.error('[svartaksi] bus shell model failed to load', error);
      if (devMode) pushLog('warn', 'load', 'bus shell model failed — keeping the procedural body');
    });

    /**
     * The phone's torch. One spotlight, parked at the camera and re-aimed down its view
     * direction every frame it is on — a torch you hold is a torch that points where you
     * are looking, and driving it from the camera rather than from the player's body is
     * what makes that true in every camera mode including freecam.
     *
     * Three's forward renderer charges every MeshStandardMaterial fragment in the scene
     * for each active light, so this is switched fully off (intensity 0) rather than
     * dimmed whenever the phone is shut — see FLASHLIGHT_INTENSITY.
     */
    const flashlight = new THREE.SpotLight(0xf6f2e4, 0, 42, Math.PI / 9, 0.42, 1.2);
    flashlight.name = 'player:flashlight';
    flashlight.castShadow = false;
    flashlightRef.current = flashlight;
    scene.add(flashlight, flashlight.target);

    const { group: person, materials: personMaterials } = createPersonModel();
    person.userData[INSPECTION_USER_DATA_KEY] = {
      id: 'runtime:player', category: 'player', title: 'Player', source: 'runtime', properties: { kind: 'pill' },
    } satisfies WorldInspectionRecord;
    person.visible = false;
    personRef.current = person;
    personMaterialsRef.current = personMaterials;
    scene.add(person);

    // The blob's GLB decodes asynchronously (see blobModel.ts), so the group it will be
    // parented into is added to the scene empty and hidden now, and the character mesh
    // grows into it whenever the load finishes — which may be well after this frame.
    const blob = new THREE.Group();
    blob.name = 'blob';
    blob.userData[INSPECTION_USER_DATA_KEY] = {
      id: 'runtime:blob', category: 'player', title: 'Player', source: 'runtime', properties: { kind: 'blob' },
    } satisfies WorldInspectionRecord;
    blob.visible = false;
    blobRef.current = blob;
    scene.add(blob);
    if (devMode) pushLog('info', 'load', 'blob character model: fetching');
    loadBlobModel().then((model) => {
      if (disposedRef.current) return;
      blob.add(model.group);
      blobModelRef.current = model;
      blobReadyRef.current = true;
      if (devMode) pushLog('info', 'load', 'blob character model ready');
    }).catch((error: unknown) => {
      console.error('[svartaksi] blob character model failed to load', error);
    });

    // Same contract as the bus: the car is drivable from the first frame as the stand-in
    // built to the Saab's own measurements, and the asset replaces its body and wheels in
    // place when it decodes (carModel.applySaabShell). A failed fetch costs the looks, not
    // the car.
    if (devMode) pushLog('info', 'load', 'saab 90 model: fetching');
    loadSaabShell().then((shell) => {
      if (disposedRef.current) return;
      applySaabShell(carModel, shell);
      if (devMode) pushLog('info', 'load', 'saab 90 model ready');
    }).catch((error: unknown) => {
      console.error('[svartaksi] saab 90 model failed to load', error);
      if (devMode) pushLog('warn', 'load', 'saab 90 model failed — keeping the stand-in body');
    });

    // Keep a detached placeholder because the frame loop shares positioning and camera
    // paths across player modes. Loading and scene placement stay off with the feature.
    const horse = new THREE.Group();
    horse.name = 'horse';
    horse.userData[INSPECTION_USER_DATA_KEY] = {
      id: 'runtime:horse', category: 'player', title: 'Horse', source: 'runtime', properties: { kind: 'horse' },
    } satisfies WorldInspectionRecord;
    horseRef.current = horse;
    if (HORSE_ENABLED) {
      scene.add(horse);
      if (devMode) pushLog('info', 'load', 'horse model: fetching');
      loadHorseModel().then((model) => {
        if (disposedRef.current) return;
        horse.add(model.group);
        horseModelRef.current = model;
        horseReadyRef.current = true;
        if (devMode) pushLog('info', 'load', 'horse model ready');
      }).catch((error: unknown) => {
        console.error('[svartaksi] horse model failed to load', error);
      });
    }

    // The camp in the woods. Built once at mount rather than per stream: it is a fixed
    // authored place (see CAMP_LOCATION), so nothing about it depends on which tiles
    // happen to be loaded — only its ground height does, and that is re-read below when
    // world data arrives.
    const campSeats = campLayout();
    campSeatsRef.current = campSeats;
    const camp = createBonfireCamp(campSeats);
    const campLocal = lngLatToLocal(START_LOCATION, CAMP_LOCATION);
    camp.group.position.set(campLocal.x, 0, campLocal.z);
    camp.pills.forEach((pill, index) => {
      pill.userData[INSPECTION_USER_DATA_KEY] = {
        id: `runtime:bonfire-pill:${index}`,
        category: 'object',
        title: 'A pill',
        source: 'runtime',
        // Deliberately uninformative. The inspector is a debug readout everywhere else in
        // this world; here it is one more thing that declines to answer.
        properties: { kind: 'pill', warmth: 'yes', name: '—', answer: 'not for you' },
      } satisfies WorldInspectionRecord;
    });
    campRef.current = camp;
    scene.add(camp.group);
    if (devMode) pushLog('info', 'load', `bonfire camp built (${camp.pills.length} seats)`);

    // The dog companion (backlog item 16). Same shape as the camp immediately above:
    // built once at mount since it is an authored point, re-seated whenever world data
    // arrives because only a fresh snapshot can answer "is this point clear" and "how
    // high is the ground here".
    const dog = createDogModel();
    dog.group.visible = false;
    dogModelRef.current = dog;
    scene.add(dog.group);
    if (devMode) pushLog('info', 'load', 'dog companion model ready');

    const placeDog = (data: WorldData, resetPosition: boolean) => {
      const point = resetPosition
        ? resolveCampPoint(DOG_SPAWN_LOCAL, (candidate) => isSafeSpawnPoint(candidate, data))
        : { x: dogStateRef.current.x, z: dogStateRef.current.z };
      const ground = terrainHeightAtIndexed(point, terrainIndexRef.current);
      dogStateRef.current = { ...dogStateRef.current, x: point.x, z: point.z, y: ground };
      dog.group.position.set(point.x, ground, point.z);
      dog.group.visible = true;
    };

    const disposeDogDebugBridge = installDogDebugBridge({
      read: (): SvartaksiDogSnapshot | null => {
        if (!dogModelRef.current) return null;
        const state = dogStateRef.current;
        return { x: state.x, z: state.z, behavior: state.behavior, trust: state.trust };
      },
    });

    const disposeBusRiderDebugBridge = installBusRiderDebugBridge({
      read: (): SvartaksiBusRiderSnapshot | null => {
        const bus = busRef.current;
        const activePerson = personRef.current;
        if (!bus || !activePerson) return null;
        return {
          phase: busLifecycleRef.current.phase,
          mode: controlRef.current.mode,
          bus: { x: bus.position.x, z: bus.position.z, rotationY: bus.rotation.y },
          person: { x: activePerson.position.x, z: activePerson.position.z },
          riderLocal: { x: riderLocalOffsetRef.current.x, z: riderLocalOffsetRef.current.z },
        };
      },
      board: () => debugBoardBusRef.current(),
    });

    const disposeCameraDebugBridge = installCameraDebugBridge({
      read: (): SvartaksiCameraSnapshot | null => ({
        mode: controlRef.current.cameraMode,
        position: {
          x: freecamPositionRef.current.x,
          y: freecamPositionRef.current.y,
          z: freecamPositionRef.current.z,
        },
        yaw: freecamYawRef.current,
        pitch: freecamPitchRef.current,
        canRelocate: canRelocateWorld(busLifecycleRef.current),
      }),
      setMode: (mode) => setCameraRef.current(mode),
      moveWorld: (x, z) => debugMoveWorldRef.current(x, z),
      place: ({ x, y, z, yaw, pitch }) => {
        if (controlRef.current.cameraMode !== 'freecam') return false;
        freecamPositionRef.current.set(x, y, z);
        freecamYawRef.current = yaw;
        freecamPitchRef.current = THREE.MathUtils.clamp(pitch, -FREECAM.maxPitch, FREECAM.maxPitch);
        // Entering freecam arms a one-shot seed that copies the live camera over these
        // refs on the next frame (see the freecam block in useFrame). Leaving it armed
        // would overwrite this placement before it was ever drawn, which is the whole
        // failure this bridge exists to avoid.
        freecamSeedPendingRef.current = false;
        return true;
      },
    });

    const flushDogTrust = () => saveDogTrustToStorage(window.localStorage, dogStateRef.current);
    window.addEventListener('pagehide', flushDogTrust);

    /**
     * Re-seats the camp whenever a snapshot arrives. Two things can only be answered
     * from world data: whether the authored point is clear of buildings and water, and
     * how high the ground is there. A wood extrudes to about a metre, so a camp left at
     * y=0 inside one is a fire burning underground.
     */
    placeCampRef.current = (data: WorldData) => {
      const point = resolveCampPoint(campLocal, (candidate) => isSafeSpawnPoint(candidate, data));
      // terrainClearanceRef is refreshed from this same snapshot immediately before every
      // call to this, so building a second profile here would only walk every landuse
      // polygon again to reach the identical answer.
      const ground = terrainHeightAtIndexed(point, terrainIndexRef.current);
      camp.group.position.set(point.x, ground, point.z);
    };

    // Collected once, from the three things the player has to be able to pick out of a
    // dark street. Everything already emissive on its own account — the bus headlight
    // lenses, its destination display, its saloon panels — is skipped by the collector.
    nightGlowMaterialsRef.current = [car, bus, person].flatMap(collectNightGlowMaterials);

    // A gradient (horizon → zenith) dome with a fading star field and moon — replaces
    // the flat scene.background as what's actually visible above the horizon;
    // scene.background/fog stay a matching flat fallback (see applyTimeOfDay).
    const skyDome = createSkyDome();
    scene.add(skyDome.object);
    skyDomeRef.current = skyDome;

    const world = createThreeWorld(scene);
    worldRef.current = world;
    const removeCaptureAfterRender = addAfterEffect(() => {
      const capture = performanceCaptureRef.current;
      if (!capture.isCapturing()) return;
      capture.recordRenderedFrame(gl.info, world.buildDiagnostics());
    });

    /**
     * The physics world. Its ground is the same landuse extrusion profile the renderer
     * builds its terrain from, read through the same function — so a wheel resting on a
     * park is resting on exactly the surface that is drawn under it, with no second
     * height model to drift out of agreement with the first.
     *
     * A road that stands off the ground additionally reads its own height from
     * `world.getRoadElevationProfiles()` — the identical `RoadElevationProfile` map
     * buildRoadGeometry samples to draw the deck — so a vehicle on a bridge is grounded
     * on the deck it's actually driving on, not the terrain far beneath it, with no snap
     * between the two height models (backlog item 8). That map holds only the roads grade
     * separation actually reaches (the decks, the crossings they clear, and the approach
     * ramps that carry them back to street level), so the scan is skipped entirely for
     * the plain-ground majority of the world and this stays as cheap as it always was
     * anywhere with no grade separation.
     */
    const physics = createPhysicsWorld();
    physics.setGroundHeight((x, z, maxHeight) => {
      const terrain = terrainHeightAtXZIndexed(x, z, terrainIndexRef.current);
      const profiles = world.getRoadElevationProfiles();
      if (profiles.size === 0) return terrain;
      const roadHeight = roadElevationAtPoint(x, z, profiles, 0, maxHeight);
      return roadHeight === null ? terrain : Math.max(terrain, roadHeight);
    });
    physicsRef.current = physics;

    const carVehicle = createCarVehicle();
    carVehicleRef.current = carVehicle;
    physics.addBody(carVehicle.chassis);
    physics.addVehicle(carVehicle);
    syncCarBodyFromGroup(carVehicle, car);

    const busBody = createBody({
      id: 'vehicle:bus',
      // Twelve tonnes: a full twelve-metre city bus. It is the number that decides what a
      // bus can drive through, and the answer should be "most of this list".
      mass: 12_000,
      colliders: [collider(box(1.32, 1.6, 5.9), new THREE.Vector3(0, 1.6, 0))],
      friction: 0.6,
      restitution: 0.05,
      neverSleep: true,
      userData: {
        kind: 'bus',
        category: CATEGORY_BUS,
        // Everything except buildings: the bus is steered along its route, not stopped by
        // contact forces, and a building's static frame fighting that spline every tick it
        // brushes a wall is exactly the "destabilize static collision solving" backlog
        // item 4 calls out. It still collides with the car, props and the pill as before.
        mask: CATEGORY_ALL & ~CATEGORY_BUILDINGS,
      },
    });
    busBodyRef.current = busBody;
    physics.addBody(busBody);

    const personBody = createBody({
      id: 'player:person',
      mass: 80,
      colliders: [collider(sphere(0.42), new THREE.Vector3(0, 0.85, 0))],
      friction: 0.8,
      restitution: 0,
      neverSleep: true,
      userData: { kind: 'person', category: CATEGORY_PILL, mask: CATEGORY_ALL },
    });
    personBodyRef.current = personBody;
    physics.addBody(personBody);

    const propLayer = createPropLayer(physics);
    propLayerRef.current = propLayer;

    // Static building colliders (backlog item 4): one oriented box (or, for concave and
    // multi-ring footprints, a perimeter of thin wall segments) per building, streamed in
    // and out as the player moves — see buildingLayer.ts for the hysteresis and descriptor
    // reuse that keeps that streaming cheap.
    const buildingLayer = createBuildingLayer(physics, { category: CATEGORY_BUILDINGS, mask: CATEGORY_ALL });
    buildingLayerRef.current = buildingLayer;
    const bridgeLayer = createBridgeLayer(physics);
    bridgeLayerRef.current = bridgeLayer;

    const physicsDebug = createPhysicsDebugRenderer();
    physicsDebugRef.current = physicsDebug;
    scene.add(physicsDebug.object);
    const inspectionHighlight = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x5ce0ff,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    );
    inspectionHighlight.name = 'runtime:inspection-highlight';
    inspectionHighlight.matrixAutoUpdate = false;
    inspectionHighlight.visible = false;
    inspectionHighlight.renderOrder = 10;
    scene.add(inspectionHighlight);
    inspectionHighlightRef.current = inspectionHighlight;

    // sun.target must be in the scene graph for its transform to update — offset
    // (not absolute position) from the car, so the shadow frustum travels with it.
    scene.add(sunRef.current.target);

    const applyTimeOfDay = (hours: number) => {
      sunOffsetVecRef.current.copy(sunOffset(hours));
      // The sun's angle just changed, which moves every shadow in the scene even if the
      // frustum's ground target hasn't — the baked shadow map is stale regardless of the
      // recentre threshold below.
      shadowNeedsUpdateRef.current = true;
      const sky = skyState(hours);
      const sun = sunRef.current;
      const ambient = ambientRef.current;
      sun.color.copy(sky.sunColor);
      sun.intensity = sky.sunIntensity;
      ambient.color.copy(sky.ambientSkyColor);
      ambient.groundColor.copy(sky.ambientGroundColor);
      ambient.intensity = sky.ambientIntensity;
      (scene.background as THREE.Color).copy(sky.backgroundColor);
      (scene.fog as THREE.FogExp2).color.copy(sky.backgroundColor);
      // Custom shaders share the sun/ambient terms explicitly; their dynamic-light
      // contribution separately consumes Three's point and spot light uniforms.
      world.setSceneLighting(sceneLighting(hours));
      skyDome.update({
        horizonColor: sky.backgroundColor,
        zenithColor: sky.zenithColor,
        starVisibility: sky.starVisibility,
        moonDirection: sky.moonDirection,
      });
      const nightFactor = sceneLighting(hours).nightFactor;
      nightFactorRef.current = nightFactor;
      setBusNightFactor(busModel, nightFactor);
      // The modelled shell's own lamps, driven from the same night factor that lights the
      // procedural ones. Headlamps and tail lamps come on together after dusk, as a bus's
      // do — one switch on the dash, not two — and both are no-ops until the asset lands.
      const shell = busShellRef.current;
      if (shell) {
        setLampIntensity(shell.lamps.head, nightFactor > 0.3 ? 1.6 * nightFactor : 0);
        setLampIntensity(shell.lamps.tail, nightFactor > 0.3 ? 0.6 * nightFactor : 0);
      }
      applyNightGlow(nightGlowMaterialsRef.current, nightFactor);
    };

    /**
     * Drives the first world's build off the event loop instead of the render loop, for
     * as long as the curtain is up. Self-rescheduling with a zero delay, so the browser
     * gets a turn between ticks — the curtain keeps animating and input keeps arriving
     * — while the build still gets essentially all the time there is.
     *
     * Stops of its own accord the moment the build finishes or the curtain goes away;
     * useFrame is what notices and publishes the ready status.
     */
    const pumpBehindCurtain = () => {
      curtainPumpTimerRef.current = 0;
      if (disposedRef.current) return;
      if (pendingReadyRef.current?.status.mode !== 'initial') return;
      if (!world.pump(CURTAIN_BUILD_BUDGET_MS)) return;
      curtainPumpTimerRef.current = window.setTimeout(pumpBehindCurtain, 0);
    };

    const loadWorld = (
      source: WorldSource,
      center: { lng: number; lat: number },
      streaming: boolean,
      corridor?: WorldDataCorridor,
    ) => {
      const request = ++generationRef.current;
      pendingReadyRef.current = null;
      lastBuildProgressAtRef.current = 0;
      window.clearTimeout(curtainPumpTimerRef.current);
      curtainPumpTimerRef.current = 0;
      const mode = streaming ? 'streaming' : 'initial';
      lastLoadRef.current = { source, center, streaming, corridor };
      worldReadyRef.current = false;
      activeControllerRef.current?.abort();
      callbacksRef.current.onStatus({
        source,
        phase: 'loading',
        mode,
        progress: 0,
        message: corridor
          ? 'Streaming the route ahead'
          : streaming
            ? 'Streaming world ahead of camera'
            : 'Loading world data',
        details: ['Checking the world cache, then loading area data or decoding vector tiles as needed.'],
        retryable: false,
      });
      const controller = new AbortController();
      activeControllerRef.current = controller;
      const cacheKey = worldCacheKey(source, center, corridor);
      worldDataCacheRef.current.load(
        cacheKey,
        // Explicitly foreground: this corridor is about to be the world on screen, not a
        // route-finding fetch queued behind it — see WorldDataProvider.load's priority.
        signal => resolveWorldData(cacheKey, center, signal, corridor),
        controller.signal,
      ).then((data) => {
        if (disposedRef.current || request !== generationRef.current) return;
        callbacksRef.current.onStatus({
          source, phase: 'loading', mode, progress: FETCH_PROGRESS_SHARE,
          message: 'Preparing terrain, water and building collision data',
          details: [`Loaded ${data.buildings.length} buildings; ${data.roads.length} roads; ${data.water.length} water areas; ${data.parks.length} green areas; ${data.objects.length} street objects`],
          retryable: false,
        });
        currentDataRef.current = data;
        // The physics ground follows the rendered terrain, so it has to be refreshed from
        // the same snapshot the renderer is about to build from.
        terrainClearanceRef.current = groundProfile(data, controlRef.current.renderOptions);
        terrainIndexRef.current = buildTerrainIndex(terrainClearanceRef.current);
        waterIndexRef.current = buildWaterIndex(data.water, terrainIndexRef.current);
        // Collision uses the full building set, not whatever threeWorld currently has
        // instanced (rendering visibility must not control collision — backlog item 4).
        buildingLayerRef.current?.setWorld(data.buildings, terrainClearanceRef.current);
        placeCampRef.current(data);
        placeDog(data, true);
        // Every rebuild is sliced now, the first one included: it is the one most worth
        // slicing, because it is the largest and the only one the player is sitting and
        // watching. See CURTAIN_BUILD_BUDGET_MS.
        world.replace(data, { incremental: true });
        labelsRef.current = data.labels;
        pendingReadyRef.current = {
          request,
          status: {
            source,
            phase: 'ready',
            mode,
            progress: 1,
            message: `${START_LOCATION_NAME} / ${corridor ? 'route ahead streamed' : streaming ? 'camera-ahead world streamed' : 'MapLibre + live OSM'}`,
            retryable: false,
          },
        };
        if (!streaming) pumpBehindCurtain();
      }).catch((error: unknown) => {
        if (disposedRef.current || request !== generationRef.current) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        callbacksRef.current.onStatus({
          source,
          phase: 'error',
          mode,
          progress: 0,
          message: error instanceof Error ? error.message : 'Source unavailable',
          retryable: true,
        });
      });
    };

    loadWorldRef.current = loadWorld;

    const applySource = (source: WorldSource) => {
      if (!canRelocateWorld(busLifecycleRef.current)) return;
      activeSourceRef.current = source;
      streamAnchorRef.current.set(0, 0);
      streamedCenterRef.current.set(0, 0);
      loadWorld(source, START_LOCATION, false);
    };

    const retryWorldLoad = () => {
      const last = lastLoadRef.current;
      if (last) loadWorld(last.source, last.center, last.streaming, last.corridor);
    };

    let appliedRenderOptions: RenderOptions | null = null;
    const applyRenderOptions = (options: RenderOptions) => {
      const appearanceOnly = appliedRenderOptions !== null && onlyWindowOptionsChanged(appliedRenderOptions, options);
      appliedRenderOptions = options;
      if (appearanceOnly) {
        world.setRenderOptions(options);
        return;
      }
      physicsDebugRef.current?.setVisible(options.physicsWireframe);
      // Terrain settings change the shape of the ground itself, so the physics profile is
      // rebuilt from the same snapshot the renderer is about to rebuild from — otherwise
      // the car keeps driving on the relief it had before the slider moved.
      const currentData = currentDataRef.current;
      if (currentData) {
        terrainClearanceRef.current = groundProfile(currentData, options);
        terrainIndexRef.current = buildTerrainIndex(terrainClearanceRef.current);
        // Terrain height is what a water sheet's own height is measured from, so a relief
        // change moves the water with it — see waterSurfaceHeightAtIndexed.
        waterIndexRef.current = buildWaterIndex(currentData.water, terrainIndexRef.current);
        placeCampRef.current(currentData);
        placeDog(currentData, false);
        // Building base elevations are sampled from this same profile; a stale one would
        // leave colliders floating above or buried under whichever relief setting just
        // changed.
        buildingLayerRef.current?.setWorld(currentData.buildings, terrainClearanceRef.current);
      }
      const quality = resolveEffectiveRenderQuality(options, renderBudgetRef.current.getScale());
      gl.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
      gl.setSize(gl.domElement.clientWidth, gl.domElement.clientHeight, false);
      // Renderer-level shadowMap.enabled goes through React state (setShadowsEnabled →
      // <Canvas shadows={...}>), not a direct gl.shadowMap.enabled mutation — see the
      // comment on <Canvas>'s shadows prop for why: R3F re-applies its own `shadows`
      // prop default (unconditionally, on every Canvas re-render) via an internal
      // effect with no dependency array, so an imperative mutation here would keep
      // getting silently overwritten back to that default.
      setShadowsEnabledRef.current(quality.shadows);
      sunRef.current.castShadow = quality.shadows;
      const shadowConfig = shadowQualityFor(quality.shadowTier, true);
      const shadow = sunRef.current.shadow;
      shadow.mapSize.set(shadowConfig.mapSize, shadowConfig.mapSize);
      shadow.camera.left = -shadowConfig.extent;
      shadow.camera.right = shadowConfig.extent;
      shadow.camera.top = shadowConfig.extent;
      shadow.camera.bottom = -shadowConfig.extent;
      // The light sits SUN_DISTANCE from its target, which travels with the car. The
      // OrthographicCamera defaults (0.5/500) spread the depth range over ten times the
      // slab that actually holds geometry, and that wasted range is depth precision the
      // shadow comparison never gets. SHADOW_CAMERA_NEAR clears the tallest building the light can be
      // behind, SHADOW_CAMERA_FAR reaches just past the ground under the target.
      shadow.camera.near = SHADOW_CAMERA_NEAR;
      shadow.camera.far = SHADOW_CAMERA_FAR;
      shadow.bias = -0.0003;
      shadow.normalBias = shadowConfig.normalBias;
      shadow.radius = shadowConfig.radius;
      shadow.camera.updateProjectionMatrix();
      // What the frustum has to be snapped to each frame so it stops crawling — see
      // shadowSnap. Recorded here because this is where extent and mapSize are decided.
      shadowTexelRef.current = quality.shadows
        ? shadowTexelSize(shadowConfig.extent, shadowConfig.mapSize)
        : 0;
      shadow.map?.dispose();
      shadow.map = null;
      // The frustum extent/mapSize/tier (and possibly shadows themselves) just changed,
      // and the old map was just disposed — the next frame must render a fresh one
      // regardless of how little the recentre target has moved.
      shadowNeedsUpdateRef.current = true;
      fogDensityTargetRef.current = fogDensityFor(quality.buildingDistance);
      world.setRenderOptions(options);
    };

    const applyTeleport = (lng: number, lat: number) => {
      if (!canRelocateWorld(busLifecycleRef.current)) return;
      const local = lngLatToLocal(START_LOCATION, { lng, lat });
      car.position.x = local.x;
      car.position.z = local.z;
      // The car kept whatever height it had wherever it came from — so arriving from a
      // bridge deck left it hanging several metres over the street it landed on, and
      // arriving from anywhere left the pill at a literal zero regardless of the ground.
      car.position.y = groundHeightAt(local.x, local.z);
      const carVehicle = carVehicleRef.current;
      if (carVehicle) syncCarBodyFromGroup(carVehicle, car);
      if (controlRef.current.mode === 'foot') {
        // Move both, keeping their relative placement: teleporting the car out from
        // under the pill would strand it on the far side of the city with no ride.
        const x = local.x - Math.cos(person.rotation.y) * CAR.alightSideOffset;
        const z = local.z + Math.sin(person.rotation.y) * CAR.alightSideOffset;
        const settled = settleOnSurface(x, z);
        person.position.set(x, settled.y, z);
        personSwimRef.current = { swimming: settled.swimming, vx: 0, vz: 0 };
        personVerticalRef.current.verticalVelocity = 0;
        personVerticalRef.current.grounded = true;
        // Whatever bus it was standing in is not here any more.
        insideBusRef.current = false;
      } else if (controlRef.current.mode === 'blob') {
        const x = local.x - Math.cos(blob.rotation.y) * CAR.alightSideOffset;
        const z = local.z + Math.sin(blob.rotation.y) * CAR.alightSideOffset;
        const settled = settleOnSurface(x, z);
        blob.position.set(x, settled.y, z);
        blobSwimRef.current = { swimming: settled.swimming, vx: 0, vz: 0 };
        blobVerticalRef.current.verticalVelocity = 0;
        blobVerticalRef.current.grounded = true;
      }
      velocityRef.current = 0;
    };

    const applySpawnRandomPlace = () => {
      if (!canRelocateWorld(busLifecycleRef.current)) return false;
      const data = currentDataRef.current;
      if (!data) return false;
      const spawn = chooseRandomSpawn(data);
      if (!spawn) return false;
      applyTeleport(spawn.lngLat.lng, spawn.lngLat.lat);
      return true;
    };

    // Read through the refs, not the captured props: these closures are created once
    // in the mount effect and would otherwise pin the first render's callbacks.
    const setMode = (mode: PlayerMode) => {
      if (controlRef.current.mode === mode) return;
      controlRef.current.mode = mode;
      callbacksRef.current.onMode(mode);
    };
    setModeRef.current = setMode;
    const setCamera = (mode: CameraMode) => {
      if (controlRef.current.cameraMode === mode) return;
      // Freecam takes over from wherever the view already is, rather than from whatever
      // position it was left at the last time it was used (or the world origin, on the
      // first use). Entering it should feel like the camera simply detached — anything
      // else teleports you across the city on a keypress.
      if (mode === 'freecam') freecamSeedPendingRef.current = true;
      controlRef.current.cameraMode = mode;
      callbacksRef.current.onCameraMode(mode);
    };
    setCameraRef.current = setCamera;
    const setHint = (hint: string | null) => {
      if (hintRef.current === hint) return;
      hintRef.current = hint;
      callbacksRef.current.onHint(hint);
    };
    setHintRef.current = setHint;
    /** One line, said once. Repeats are legitimate — a pill's sequence wraps — so the
     * consumer, not this, is what has to make the same string twice read as two events;
     * see HudSpeech. */
    const say = (line: string) => {
      callbacksRef.current.onSpeech(line);
    };
    sayRef.current = say;

    /** Unit vectors for a heading, in this world's forward = (sin h, 0, cos h)
     * convention. +x is left of forward, so the kerb side is the negated one. */
    const basis = (heading: number) => ({
      forward: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
      right: new THREE.Vector3(-Math.cos(heading), 0, Math.sin(heading)),
    });

    /** Puts the pill at a world position with its feet on `groundY`, and restarts
     * the fade — every appearance it makes is a fade-in from nothing. */
    /**
     * Where a body set down at (x, z) ends up, and whether it is swimming there.
     *
     * The one rule for putting a body somewhere it was not standing a moment ago — an
     * ejection from a sinking car, a teleport. "Never spawns below the surface" is an
     * acceptance criterion of backlog item 10, and a pill dropped at ground level in four
     * metres of water is under it; so is one dropped at y=0 inside a landuse mound.
     */
    const settleOnSurface = (x: number, z: number, feetY = Infinity) => {
      const { standY, waterY } = surfaceUnderBody(x, z, feetY);
      return settleHeight(standY, waterY);
    };

    const placePerson = (x: number, groundY: number, z: number, heading: number) => {
      person.position.set(x, groundY, z);
      person.rotation.y = heading;
      personHeadingRef.current = heading;
      personFadeRef.current = 0;
      person.visible = true;
    };

    /**
     * Car space <-> world space.
     *
     * The whole get-in/get-out sequence is computed in the car's own frame (see
     * vehicleEntry.ts), which is what lets a car that is rolling, or parked on a slope
     * with its nose anywhere, carry a half-seated player correctly rather than dragging
     * them along a world-space line. These two functions are the only place the two frames
     * meet, and they are re-read every frame because the car moves during the sequence.
     */
    const _carLocal = new THREE.Vector3();
    const toCarLocal = (world: THREE.Vector3): THREE.Vector3 =>
      _carLocal.copy(world).sub(car.position).applyAxisAngle(WORLD_UP, -car.rotation.y).clone();
    const toCarWorld = (local: THREE.Vector3): THREE.Vector3 =>
      _carLocal.copy(local).applyAxisAngle(WORLD_UP, car.rotation.y).add(car.position).clone();

    /** The level everything left behind at a stop is placed on. Ground queries answer with
     * the highest surface at or below what they are given, so handing them the bus's own
     * height is what keeps the car and the horse on the street the bus actually stopped on
     * rather than on a deck crossing overhead — or, as before, at a literal zero. */
    const alightGroundReference = () => bus.position.y + BUS_SUSPENSION_STEP_REACH;

    /** Starts the scripted seat-to-curb walk after the door has opened. Player mode
     * remains `bus` until the path reaches the curb, keeping manual input disabled. */
    const beginAutomaticAlight = () => {
      if (controlRef.current.mode !== 'bus') return;
      const heading = bus.rotation.y;
      const { forward, right } = basis(heading);

      const stop = bus.position.clone();
      // Start the alight walk from wherever the rider actually was standing, not the
      // fixed seat spot — the player can walk the cabin while riding, so by the time
      // the bus stops they may be nowhere near the seat. The pill is also likely
      // already visible and faded in from that walk, so only reset the fade if it
      // was not — otherwise disembarking flashes a fade-in on an already-visible pill.
      alightStartLocalRef.current = { ...riderLocalOffsetRef.current };
      const riderWorld = computeRiderWorldPosition(stop, heading, riderLocalOffsetRef.current);
      const wasVisible = person.visible;
      person.position.set(riderWorld.x, BUS_FLOOR_Y, riderWorld.z);
      person.rotation.y = heading;
      personHeadingRef.current = heading;
      if (!wasVisible) personFadeRef.current = 0;
      person.visible = true;
      insideBusRef.current = false;
      busDoorOpenRef.current = true;

      const carPickupX = stop.x + forward.x * CAR.pickupForward + right.x * CAR.pickupSide;
      const carPickupZ = stop.z + forward.z * CAR.pickupForward + right.z * CAR.pickupSide;
      car.position.set(carPickupX, groundHeightAt(carPickupX, carPickupZ, alightGroundReference()), carPickupZ);
      car.rotation.y = heading;
      headingRef.current = heading;
      velocityRef.current = 0;

      // The horse waits a little further off, at its own offset from the stop (see
      // gameplayConfig.HORSE) — reachable on the same walk that finds the car, without
      // the two standing on top of each other.
      const horse = horseRef.current;
      if (horse) {
        const horseX = stop.x + forward.x * HORSE.pickupForward + right.x * HORSE.pickupSide;
        const horseZ = stop.z + forward.z * HORSE.pickupForward + right.z * HORSE.pickupSide;
        const horseGround = groundHeightAt(horseX, horseZ, alightGroundReference());
        horseStateRef.current = { mode: 'idle', gait: 'stand', x: horseX, z: horseZ, y: horseGround, heading };
        horse.position.set(horseX, horseGround, horseZ);
        horse.rotation.y = heading;
      }

      busSpeedRef.current = 0;
      setHint('GETTING OFF…');
      if (controlRef.current.cameraMode !== 'freecam') setCamera('chase');
    };

    alightRef.current = beginAutomaticAlight;

    /**
     * Puts the player out of a car that has started to sink (backlog item 10).
     *
     * The search is for a point that is *not itself deep water*, ringing outward from the
     * car: nosing in from a quay leaves the bank a couple of metres behind you, and coming
     * off a bridge leaves nothing dry for a long way. Where nothing validates — the middle
     * of a bay — the pill is set down beside the car anyway and starts the sequence
     * swimming, which is the honest outcome and the one the swim state exists for. That is
     * the backlog's "recovery fallback if no safe ejection point exists": a fallback
     * placement, never a silent teleport across the map.
     */
    const ejectFromSinkingCar = () => {
      const safe = findEjectionPoint(
        car.position, EJECTION_DIRECTIONS, EJECTION_RADIUS_START, EJECTION_RADIUS_STEP, EJECTION_MAX_RADIUS,
        (x, z) => {
          // Shallow enough to stand in counts as safe; the point of the search is to find
          // the shore, and the shore is exactly where the water stops being over your head.
          const { standY, waterY } = surfaceUnderBody(x, z, car.position.y);
          return waterY === null || waterY - standY < SWIM_ENTER_DEPTH;
        },
      );
      const { right } = basis(car.rotation.y);
      const x = safe ? safe.x : car.position.x - right.x * CAR.alightSideOffset;
      const z = safe ? safe.z : car.position.z - right.z * CAR.alightSideOffset;
      const settled = settleOnSurface(x, z, car.position.y);
      placePerson(x, settled.y, z, car.rotation.y);
      // Seeded rather than left to the first movement tick to work out: the pill is in
      // the water at the moment it appears, and one tick of walk physics before the
      // hysteresis catches up is one tick of it standing on the bottom.
      personSwimRef.current = { swimming: settled.swimming, vx: 0, vz: 0 };
      personVerticalRef.current.verticalVelocity = 0;
      personVerticalRef.current.grounded = true;
      insideBusRef.current = false;
      velocityRef.current = 0;
      setModeRef.current('foot');
      pushLog('info', 'car', 'car in the water — player ejected');
    };
    ejectFromSinkingCarRef.current = ejectFromSinkingCar;

    const applyToggleVehicle = () => {
      const mode = controlRef.current.mode;
      if (mode === 'car') {
        if (carTransitionRef.current) return;
        // Mode flips to `foot` up front — the player is no longer driving the moment they
        // ask to get out — but the pill is put in the seat, not on the pavement, and walks
        // itself out over the next second. `inputPaused` is what stops it being steered
        // while it does.
        const speed = carVehicleRef.current?.forwardSpeed() ?? 0;
        const seatWorld = toCarWorld(CAR_ACCESS.seat);
        placePerson(seatWorld.x, seatWorld.y, seatWorld.z, car.rotation.y);
        carTransitionRef.current = beginVehicleExit(CAR_ACCESS, speed);
        controlRef.current.inputPaused = true;
        insideBusRef.current = false;
        velocityRef.current = 0;
        setModeRef.current('foot');
        return;
      }
      if (mode === 'horse') {
        const horse = horseRef.current;
        const state = horseStateRef.current;
        const heading = state.heading;
        const { right } = basis(heading);
        horseStateRef.current = dismountHorse(state);
        placePerson(
          state.x - right.x * HORSE.dismountSideOffset,
          state.y,
          state.z - right.z * HORSE.dismountSideOffset,
          heading,
        );
        if (horse) {
          horse.position.set(state.x, state.y, state.z);
          horse.rotation.y = heading;
        }
        insideBusRef.current = false;
        velocityRef.current = 0;
        setModeRef.current('foot');
        return;
      }
      if (mode !== 'foot') return;
      // E is one key with one meaning — "deal with the thing in front of me" — and at the
      // fire that thing is a person, not the car. The two can never be in range at once
      // (the camp is a kilometre into the woods and the car is parked in the city), so
      // this is an ordering, not a conflict.
      const listener = campListenerRef.current;
      if (listener >= 0) {
        const line = speak(campVoicesRef.current, listener);
        if (line) sayRef.current(line);
        return;
      }
      // Horse mounting is checked ahead of the car: the two are placed a stone's throw
      // apart from the same drop-off (see beginAutomaticAlight), so whichever the rider
      // is actually standing next to wins — canMount's own range check does the real
      // filtering, this ordering only matters in the unlikely case both are in range.
      if (horseReadyRef.current) {
        const riderPoint = { x: person.position.x, z: person.position.z };
        if (canMountHorse(horseStateRef.current, riderPoint)) {
          horseStateRef.current = mountHorse(horseStateRef.current, riderPoint);
          person.visible = false;
          insideBusRef.current = false;
          velocityRef.current = 0;
          setHint(null);
          setMode('horse');
          return;
        }
      }
      if (!carSpawnedRef.current) return;
      // Compared on the ground plane: while aboard the bus the pill's feet are a
      // saloon floor above the road, and a 3D distance would read that as further out.
      if (Math.hypot(person.position.x - car.position.x, person.position.z - car.position.z) > CAR_ENTER_RADIUS) return;
      if (carTransitionRef.current) return;
      insideBusRef.current = false;
      velocityRef.current = 0;
      setHint(null);
      // The pill stays visible and stays in `foot` mode: for the next two seconds it walks
      // to the door, opens it and lowers itself in, and only then does the car become the
      // thing being driven. See vehicleEntry.ts for why this is a sequence and not a
      // teleport, and the vehicleEntry block in the frame loop for what drives it.
      carTransitionRef.current = beginVehicleEntry(
        CAR_ACCESS,
        toCarLocal(person.position),
        person.rotation.y - car.rotation.y,
      );
      controlRef.current.inputPaused = true;
    };

    /**
     * Puts a car where the player can walk into it, whether or not one was in the world
     * before. The offset is the alight offset mirrored, so spawning and then pressing E
     * is the exact inverse of getting out: the car lands where it would have been parked
     * had the player just stepped off it, which is the one placement guaranteed to be
     * inside CAR_ENTER_RADIUS.
     *
     * Re-spawning an existing car recalls it instead of making a second one. There is one
     * car model and one chassis body in this scene and both are shared with the frame
     * loop, so "spawn" here always means "move the car", never "build another".
     */
    const applySpawnCar = () => {
      // A car cannot be summoned out from under a moving bus: the ride owns the player's
      // position until it sets them down, the same reason teleporting is refused midway.
      if (!canRelocateWorld(busLifecycleRef.current)) return false;
      const carVehicle = carVehicleRef.current;
      if (!carVehicle) return false;
      const mode = controlRef.current.mode;
      // Already at the wheel: there is nothing to summon, and moving the car would be
      // teleporting the player rather than parking a vehicle for them.
      if (mode === 'car') return false;
      const rider = mode === 'blob' ? blob : person;
      const heading = mode === 'blob' ? blobHeadingRef.current : personHeadingRef.current;
      const { right } = basis(heading);
      const x = rider.position.x + right.x * CAR.alightSideOffset;
      const z = rider.position.z + right.z * CAR.alightSideOffset;
      car.position.set(x, groundHeightAt(x, z, rider.position.y + 0.3), z);
      car.rotation.y = heading;
      // scene.add is idempotent on an object already parented here, but the log line is
      // not, and a recall is not a load.
      if (!carSpawnedRef.current) {
        scene.add(car);
        carSpawnedRef.current = true;
        if (devMode) pushLog('info', 'load', 'car model ready');
      }
      // The chassis is still wherever the detached body was left, and it carries the
      // velocity and steering from the last time anyone drove. This both moves it and
      // stands it still, so a recalled car does not drive off on its own.
      syncCarBodyFromGroup(carVehicle, car);
      headingRef.current = heading;
      // Recalling the car *is* the recovery from drowning it (backlog item 10 asks for
      // that to be an explicit decision rather than a silent teleport): the player asks
      // for a car, and the one they get is dry, upright and running. Without this reset a
      // recalled car would arrive still `submerged` and sink into the road beside them.
      carWaterRef.current = initialCarWaterState();
      car.rotation.x = 0;
      return true;
    };

    /**
     * Stands a library model on the ground a few metres in front of whichever body the
     * player currently is, turned to face them.
     *
     * Placed through the same ground sampler everything else uses, so a model spawned on a
     * landuse mound stands on it rather than sinking to the base plane — the bug this
     * branch has been fixing everywhere else.
     */
    const applySpawnModel = async (model: RemoteModel): Promise<RemoteModel> => {
      const mode = controlRef.current.mode;
      const body = mode === 'blob' ? blob : mode === 'car' ? car : person;
      const heading = mode === 'blob' ? blobHeadingRef.current
        : mode === 'car' ? car.rotation.y : personHeadingRef.current;
      const { forward } = basis(heading);
      const x = body.position.x + forward.x * SPAWN_FORWARD_DISTANCE;
      const z = body.position.z + forward.z * SPAWN_FORWARD_DISTANCE;

      const spawned = await loadSpawnedModel(model);
      // Disposed mid-flight: the scene went away while the GLB was downloading, and adding
      // it now would leak a group onto a torn-down scene.
      if (disposedRef.current) {
        spawned.dispose();
        return model;
      }
      spawned.group.position.set(x, groundHeightAt(x, z), z);
      // Turned to face the player rather than away — you spawn a model to look at it.
      spawned.group.rotation.y = heading + Math.PI;
      scene.add(spawned.group);
      spawnedModelsRef.current.push(spawned);
      pushLog('info', 'models', `spawned ${model.fileName}`);
      return model;
    };

    const applyTipLastSpawnedModel = (): RemoteModel | null => {
      const spawned = spawnedModelsRef.current;
      const last = spawned[spawned.length - 1];
      if (!last) return null;
      last.tip();
      return last.model;
    };

    const applyClearSpawnedModels = (): number => {
      const spawned = spawnedModelsRef.current;
      for (const entry of spawned) entry.dispose();
      const count = spawned.length;
      spawnedModelsRef.current = [];
      return count;
    };

    const applyToggleBlobForm = () => {
      const mode = controlRef.current.mode;
      if (mode === 'foot') {
        if (!blobReadyRef.current) return;
        blob.position.copy(person.position);
        blob.rotation.y = person.rotation.y;
        blobHeadingRef.current = personHeadingRef.current;
        // Starts the camera directly behind wherever the blob is already facing,
        // whichever scheme is active — see blobCameraYawRef.
        blobCameraYawRef.current = personHeadingRef.current;
        blobFacingOffsetRef.current = 0;
        insideBusRef.current = false;
        person.visible = false;
        blob.visible = true;
        setMode('blob');
        return;
      }
      if (mode !== 'blob') return;
      person.position.copy(blob.position);
      person.rotation.y = blob.rotation.y;
      personHeadingRef.current = blobHeadingRef.current;
      blob.visible = false;
      // The pill's own fade-in has to run again — it was left at full opacity from
      // whenever it was last actually shown, and a plain visible=true would pop it in.
      personFadeRef.current = 0;
      person.visible = true;
      // A drag held through the toggle would otherwise walk the pill on foot's own next
      // frame — click-to-move is blob-only.
      controlRef.current.blobPointer = null;
      setMode('foot');
    };

    const applyStartBusRide = (path: LocalPoint[], signalStops: RouteSignalStop[] = []) => {
      if (!path.length) return;
      if (busLifecycleRef.current.phase !== 'hidden') return;
      busPathRef.current = path;
      const profile = buildRideProfile(path);
      // Route feasibility is a diagnostic, not a block: buildRideProfile's speed plan is
      // safe to drive even where a corner is tighter than the bus can actually turn (the
      // per-vertex floor still applies), but that clipping must not pass silently — see
      // backlog item 2's "no silent corner clipping is accepted".
      if (profile.infeasible.length) {
        console.warn(`[svartaksi bus] ${describeInfeasibility(profile.infeasible)}`);
      }
      busProfileRef.current = profile;
      busTraveledRef.current = 0;
      busCorridorFetchedAtRef.current = Number.NEGATIVE_INFINITY;
      busSignalStopsRef.current = signalStops;
      busSpeedRef.current = 0;
      busStopAtRef.current = null;
      const start = sampleRide(path, 0);
      // Traveled distance measures the front axle, so at zero the body sits half a
      // wheelbase back from the start of the route — the same place the frame loop will
      // put it on its first tick.
      bus.position.set(
        start.point.x + Math.cos(start.heading) * BUS.laneOffset - Math.sin(start.heading) * BUS_WHEELBASE / 2,
        0,
        start.point.z - Math.sin(start.heading) * BUS.laneOffset - Math.cos(start.heading) * BUS_WHEELBASE / 2,
      );
      bus.rotation.set(0, start.heading, 0);
      busSteerRef.current = 0;
      bus.visible = true;
      busLifecycleRef.current = advanceBusLifecycle(createBusLifecycle(), {
        dt: 0,
        speed: 0,
        doorOpenFraction: 0,
        stopReached: false,
        requestedStop: false,
        requestedStart: true,
        busOffscreen: false,
      });
      placePerson(BUS_SEAT_OFFSET.x, BUS_FLOOR_Y, BUS_SEAT_OFFSET.z, 0);
      // World-space pose is recomputed every tick from riderLocalOffsetRef below (see the
      // `riding` branch), so the placePerson call above only needs to seed rotation/fade
      // state — position is overwritten before the first paint. Starting local offset is
      // the same seat spot boarding used to pin the rider to.
      riderLocalOffsetRef.current = { x: BUS_SEAT_OFFSET.x, z: BUS_SEAT_OFFSET.z };
      insideBusRef.current = true;
      busDoorOpenRef.current = false;
      // Start the ride in the chase view — the interior-scaled rig (INTERIOR_RIG) that
      // frames the rider walking the cabin. For the scripted opening ride this is only
      // the fallback the intro shot eases out of; the frame loop switches to cockpit
      // automatically once the intro finishes (see introCockpitAppliedRef in useFrame).
      // Camera mode stays switchable from here on regardless — the player can still
      // choose any other mode at any time.
      setCamera('chase');
      // The car keeps sitting exactly where it was parked; zero its velocity so it
      // does not coast on for a frame when control comes back.
      velocityRef.current = 0;
      setHint('PRESS B TO GET OFF');
      setMode('bus');
    };

    // Assigned here rather than at the bridge's install site because applyTeleport is
    // declared further down this effect; the ref is the same indirection debugBoardBus
    // already uses for the same reason.
    debugMoveWorldRef.current = (x: number, z: number): boolean => {
      if (!canRelocateWorld(busLifecycleRef.current)) return false;
      const { lng, lat } = localToLngLat(START_LOCATION, { x, z });
      applyTeleport(lng, lat);
      return true;
    };

    debugBoardBusRef.current = (): boolean => {
      if (busLifecycleRef.current.phase !== 'hidden') return false;
      const roads = currentDataRef.current?.roads ?? [];
      // Pick the longest currently-loaded road as the ride's path: it is guaranteed
      // reachable (it is already drawn on screen) and needs no corridor fetch or
      // pathfinding of its own, unlike the opening ride's cross-town route — this exists
      // purely so a test can reach the 'driving' phase without depending on the opening
      // ride's own network round trip and long-distance route search succeeding.
      let longest: WorldRoad | null = null;
      let longestLength = 0;
      for (const road of roads) {
        if (road.points.length < 2) continue;
        let length = 0;
        for (let i = 1; i < road.points.length; i += 1) {
          length += Math.hypot(road.points[i].x - road.points[i - 1].x, road.points[i].z - road.points[i - 1].z);
        }
        if (length > longestLength) {
          longestLength = length;
          longest = road;
        }
      }
      if (!longest || longestLength < 20) return false;
      applyStartBusRide(longest.points, []);
      return busLifecycleRef.current.phase !== 'hidden';
    };

    const applyStopBusRide = () => {
      if (busLifecycleRef.current.phase !== 'driving') return;
      const profile = busProfileRef.current;
      if (!profile) {
        return;
      }
      // Stop where the bus can actually stop, not where it happens to be: brake at
      // BUS_BRAKE from the current speed, clamped to the end of the route.
      busStopAtRef.current = Math.min(
        profile.length,
        busTraveledRef.current + busStopDistance(busSpeedRef.current) + BUS.stopMargin,
      );
      busLifecycleRef.current = advanceBusLifecycle(busLifecycleRef.current, {
        dt: 0,
        speed: busSpeedRef.current,
        doorOpenFraction: 0,
        stopReached: false,
        requestedStop: true,
        busOffscreen: false,
      });
      setHint('PULLING IN…');
    };

    /**
     * The game opens mid-journey rather than parked: the player boards the westbound
     * service out of Svartaksi and watches the city arrive through the window.
     *
     * The route is resolved here, at mount, rather than when the world is ready — it
     * runs over its own corridor fetch (busCorridor) and shares nothing with the
     * streamed world, so making it wait would simply add its latency to the world's
     * instead of hiding it behind it. By the time the first world is on screen this has
     * usually already settled.
     */
    const openingRideController = new AbortController();
    openingRideControllerRef.current = openingRideController;
    const openingRoute = resolveBusRoute(
      OPENING_RIDE.from,
      OPENING_RIDE.to,
      openingRideController.signal,
    ).catch(() => ({ ok: false as const, reason: 'fetch-failed' as const }));

    /**
     * Boards the player once the first world is visible. Returns true when it has taken
     * over the loading curtain, in which case it is also responsible for eventually
     * publishing `readyStatus` — every exit path publishes it exactly once. A route that
     * could not be resolved simply leaves the player at the wheel in Svartaksi, which is a
     * perfectly playable game, so there is no error path to surface.
     */
    const beginOpeningRide = (readyStatus: RuntimeStatus): boolean => {
      if (openingRidePhaseRef.current !== 'pending') return false;
      if (readyStatus.mode !== 'initial') return false;
      openingRidePhaseRef.current = 'running';

      callbacksRef.current.onStatus({
        ...readyStatus,
        phase: 'loading',
        progress: 0.97,
        message: `Boarding the service to ${OPENING_RIDE.destinationName}`,
      });

      void openingRoute.then((route) => {
        openingRidePhaseRef.current = 'done';
        if (disposedRef.current || openingRideController.signal.aborted) return;
        if (route.ok) {
          openingCamStartMsRef.current = performance.now();
          introCockpitAppliedRef.current = false;
          applyStartBusRide(route.path, route.signalStops);
        } else {
          // Silent by design (see beginOpeningRide's docstring) — the player is simply
          // left at the wheel — but a warning still belongs here so a routing regression
          // shows up in the console instead of only as "the intro shows the car".
          console.warn(`[svartaksi bus] opening ride route unavailable: ${route.reason}`);
        }
        callbacksRef.current.onStatus(readyStatus);
      });
      return true;
    };
    beginOpeningRideRef.current = beginOpeningRide;

    const captureContext = (): PerformanceCaptureContext => {
      const context = gl.getContext();
      const identity = captureRendererIdentity(context);
      return {
        environment: {
          scenarioId: 'runtime-debug',
          qualityTier: controlRef.current.renderOptions.quality,
          viewport: { width: gl.domElement.width, height: gl.domElement.height },
          devicePixelRatio: gl.getPixelRatio(),
          userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
          renderer: identity.renderer,
          vendor: identity.vendor,
          webglVersion: gl.capabilities.isWebGL2 ? 'webgl2' : 'webgl1',
          // The browser harness supplies this metadata later; do not infer it from a
          // renderer string because ANGLE and browser privacy settings make it ambiguous.
          rendererKind: 'unknown',
          warmupDurationMs: 0,
          sampleDurationMs: 0,
          buildRevision: 'runtime',
        },
        renderOptions: controlRef.current.renderOptions,
      };
    };
    const startPerformanceCapture = () => performanceCaptureRef.current.start();
    const snapshotPerformanceCapture = () => performanceCaptureRef.current.snapshot(captureContext());
    const stopPerformanceCapture = () => performanceCaptureRef.current.stop(captureContext());

    onReadyRef.current({
      applySource, applyRenderOptions, applyTimeOfDay, applyTeleport, applySpawnRandomPlace,
      applyStartBusRide, applyStopBusRide, applyToggleVehicle, applySpawnCar,
      applySpawnModel, applyClearSpawnedModels, applyTipLastSpawnedModel, applyToggleBlobForm,
      retryWorldLoad,
      startPerformanceCapture, snapshotPerformanceCapture, stopPerformanceCapture,
    });

    return () => {
      disposedRef.current = true;
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      preloadControllerRef.current?.abort();
      openingRideControllerRef.current?.abort();
      window.clearTimeout(curtainPumpTimerRef.current);
      removeCaptureAfterRender();
      worldDataCache.clear();
      applyClearSpawnedModels();
      world.dispose();
      propLayer.dispose();
      propLayerRef.current = null;
      buildingLayer.dispose();
      bridgeLayer.dispose();
      bridgeLayerRef.current = null;
      buildingLayerRef.current = null;
      scene.remove(physicsDebug.object);
      physicsDebug.dispose();
      physicsDebugRef.current = null;
      physicsRef.current = null;
      carVehicleRef.current = null;
      busBodyRef.current = null;
      personBodyRef.current = null;
      busModel.dispose();
      busShellRef.current?.dispose();
      busShellRef.current = null;
      blobModelRef.current?.dispose();
      blobModelRef.current = null;
      blobReadyRef.current = false;
      horseModelRef.current?.dispose();
      horseModelRef.current = null;
      horseReadyRef.current = false;
      // The camp owns instanced meshes and a geometry shared across five pills; the
      // generic traverse below disposes meshes but not an InstancedMesh's own buffers.
      camp.dispose();
      campRef.current = null;
      disposeDogDebugBridge?.();
      disposeBusRiderDebugBridge?.();
      disposeCameraDebugBridge?.();
      window.removeEventListener('pagehide', flushDogTrust);
      flushDogTrust();
      dog.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
        }
      });
      dog.materials.forEach((material) => material.dispose());
      scene.remove(dog.group);
      dogModelRef.current = null;
      scene.remove(bus);
      // Whatever's left in the scene at this point (car, bus, pill, sky dome, sun/ambient —
      // the buildings/roads/etc. world.dispose() already tore down are gone) — dispose
      // every mesh's geometry/material generically rather than tracking each source
      // separately. <primitive>-mounted objects (car, bus, sky dome) are never
      // auto-disposed by R3F on unmount, unlike JSX-instantiated ones, so this still
      // has real work to do even after Canvas's own teardown.
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
    };
    // Mount-once: everything above reads the latest props via the *Ref mirrors. The two
    // surface samplers are listed because they are used here, but both are useCallback
    // with no dependencies of their own, so neither ever re-runs this.
  }, [devMode, scene, gl, groundHeightAt, surfaceUnderBody]);

  useFrame((state, rawDelta) => {
    if (disposedRef.current) return;
    const car = carRef.current;
    const world = worldRef.current;
    const sun = sunRef.current;
    if (!car || !world || !sun) return;

    const dt = Math.min(rawDelta, 0.05);
    const time = state.clock.elapsedTime * 1000;
    const fixedStepsThisFrame = accumulateFixedSteps(
      rawDelta,
      simAccumulatorRef.current,
      SIMULATION.fixedDt,
      SIMULATION.maxCatchupSteps,
    );
    simAccumulatorRef.current = fixedStepsThisFrame.accumulator;

    // Spend a slice of this frame on whatever the world is still assembling. Kept well
    // under a 60fps frame's 16.7ms so the driving stays smooth while a streamed world
    // builds up behind it — the old synchronous rebuild is what froze the game outright.
    // The exception is the very first world, where there is nothing to keep smooth yet.
    const pending = pendingReadyRef.current;
    const behindCurtain = !!pending && pending.status.mode === 'initial';
    // Behind the curtain the timer loop is doing the real work (see
    // CURTAIN_BUILD_BUDGET_MS); this frame only needs to observe where it got to.
    const building = behindCurtain ? world.isBuilding() : world.pump(WORLD_BUILD_BUDGET_MS);

    // Held back until the world it describes is actually on screen, which under an
    // incremental rebuild is several frames after the data arrived.
    if (building && pending && pending.request === generationRef.current && time - lastBuildProgressAtRef.current >= BUILD_PROGRESS_INTERVAL_MS) {
      lastBuildProgressAtRef.current = time;
      callbacksRef.current.onStatus({
        ...pending.status,
        phase: 'loading',
        progress: FETCH_PROGRESS_SHARE + (1 - FETCH_PROGRESS_SHARE) * world.buildProgress(),
        message: world.buildStage(),
        details: worldBuildDetails(world.buildDiagnostics()),
      });
    }
    if (!building && pending && pending.request === generationRef.current) {
      pendingReadyRef.current = null;
      worldReadyRef.current = true;
      // The opening ride owns the curtain from here: it keeps the loading screen up
      // while it plans the route, and publishes `ready` itself once the player is
      // aboard (or once it has given up). Any other load reports ready immediately.
      if (!beginOpeningRideRef.current(pending.status)) {
        callbacksRef.current.onStatus(pending.status);
      }
    }
    const input = control.inputPaused ? {
      forward: 0,
      turn: 0,
      boost: false,
      brake: false,
      lookX: 0,
      lookY: 0,
      vertical: 0,
      jump: false,
      crouch: false,
    } : control.input.snapshot();
    const introRunning = openingCamStartMsRef.current !== null
      && performance.now() - openingCamStartMsRef.current < OPENING_CAM_INTRO_DURATION_MS;
    if (introRunning) {
      input.forward = 0;
      input.turn = 0;
      input.boost = false;
      input.brake = false;
      input.lookX = 0;
      input.lookY = 0;
      input.vertical = 0;
    }

    const bus = busRef.current;
    const person = personRef.current;
    const blob = blobRef.current;
    const horse = horseRef.current;
    const busPath = busPathRef.current;
    const busProfile = busProfileRef.current;
    if (!person || !blob || !horse) return;
    const bridgeFocus = control.mode === 'bus' && bus ? bus.position
      : control.mode === 'foot' ? person.position
        : control.mode === 'blob' ? blob.position
          : control.mode === 'horse' && horse ? horse.position : car.position;
    bridgeLayerRef.current?.setColliders(world.getBridgeColliders());
    bridgeLayerRef.current?.update(bridgeFocus);

    const physics = physicsRef.current;
    if (control.inspectorEnabled && control.inspectorPending && time - lastInspectionAtRef.current >= 50) {
      lastInspectionAtRef.current = time;
      control.inspectorPending = false;
      const rect = gl.domElement.getBoundingClientRect();
      const clientX = control.inspectorPointer?.x ?? rect.left + rect.width / 2;
      const clientY = control.inspectorPointer?.y ?? rect.top + rect.height / 2;
      inspectPointerRef.current.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycasterRef.current.setFromCamera(inspectPointerRef.current, state.camera);
      const targets = [
        ...world.getInspectionTargets(),
        car,
        ...(bus?.visible ? [bus] : []),
        ...(person.visible ? [person] : []),
        ...(blob.visible ? [blob] : []),
        horse,
      ];
      let hit: InspectionHit | null = null;
      let highlighted: THREE.Intersection | null = null;
      try {
        for (const intersection of raycasterRef.current.intersectObjects(targets, true)) {
          let inspected: THREE.Object3D | null = intersection.object;
          while (inspected && !inspected.userData[INSPECTION_USER_DATA_KEY]) inspected = inspected.parent;
          if (!inspected) continue;
          const record = recordForIntersection({ ...intersection, object: inspected });
          if (!record) continue;
          const active = control.mode === 'bus' ? bus
            : control.mode === 'foot' ? person
              : control.mode === 'blob' ? blob
                : control.mode === 'horse' ? horse : car;
          hit = {
            ...record,
            distanceMeters: Math.round(intersection.point.distanceTo(active?.position ?? car.position)),
            screenX: clientX,
            screenY: clientY,
          };
          highlighted = intersection;
          break;
        }
      } catch {
        hit = null;
      }
      const helper = inspectionHighlightRef.current;
      if (helper) {
        helper.visible = !!highlighted;
        if (highlighted && highlighted.object instanceof THREE.Mesh) {
          helper.geometry = highlightGeometryForIntersection(highlighted);
          helper.matrix.copy(highlighted.object.matrixWorld);
          if (highlighted.object instanceof THREE.InstancedMesh && highlighted.instanceId !== undefined) {
            const instanceMatrix = new THREE.Matrix4();
            highlighted.object.getMatrixAt(highlighted.instanceId, instanceMatrix);
            helper.matrix.multiply(instanceMatrix);
          }
        }
      }
      const key = hit ? `${hit.id}:${hit.distanceMeters}` : 'none';
      if (key !== lastInspectionKeyRef.current) {
        lastInspectionKeyRef.current = key;
        callbacksRef.current.onInspection(hit);
      }
    }
    if (!control.inspectorEnabled && inspectionHighlightRef.current?.visible) {
      inspectionHighlightRef.current.visible = false;
    }
    // Bus/car/person movement and bus-lifecycle timing run at a fixed tick, however many
    // (bounded) of them this real frame is owed — see SIMULATION.fixedDt. `dt` here
    // shadows the outer per-frame delta for the rest of this block only; camera, HUD and
    // every other visual-only concern below this loop keeps using the real one.
    for (let fixedStep = 0; fixedStep < fixedStepsThisFrame.steps; fixedStep += 1) {
    const dt = SIMULATION.fixedDt;
    const phaseAtFrameStart = busLifecycleRef.current.phase;
    const riding = control.mode === 'bus'
      && phaseAtFrameStart !== 'hidden'
      && !!bus;
    const traveling = riding
      && (phaseAtFrameStart === 'driving' || phaseAtFrameStart === 'braking')
      && !!busPath
      && !!busProfile;
    const onFoot = control.mode === 'foot';
    const onBlob = control.mode === 'blob';
    const onHorse = control.mode === 'horse';

    if (traveling) {
      // Autopilot: no steering input. Speed follows the precomputed profile, which
      // has already worked out how early to start braking for every corner ahead,
      // so the bus eases down before a turn instead of pivoting at full pace.
      const previousSpeed = busSpeedRef.current;
      const stopAt = busStopAtRef.current;
      // Checked fresh every tick against the live clock, not cached as blocked/clear:
      // a red the bus is braking for can turn green again before it arrives, and the
      // aspect must be re-read right up to the moment it would otherwise stop.
      const blockingSignal = nextBlockingSignalStop(
        busSignalStopsRef.current,
        busTraveledRef.current,
        state.clock.elapsedTime,
      );
      // A requested stop and a red light both layer a ceiling on top of the route
      // profile, and both drop the creep floor — that floor exists to stop the bus
      // stalling mid-route and is exactly what would prevent it ever reaching
      // standstill at a stop or a signal.
      const stopsAheadAt = [stopAt, blockingSignal?.traveledMeters ?? null]
        .filter((value): value is number => value !== null);
      const limit = stopsAheadAt.length === 0
        ? profileSpeedLimit(busProfile!, busTraveledRef.current)
        : Math.min(
          profileSpeedLimit(busProfile!, busTraveledRef.current),
          ...stopsAheadAt.map((at) => stoppingSpeedLimit(at - busTraveledRef.current)),
        );
      busSpeedRef.current = advanceRideSpeed(previousSpeed, limit, dt, stopsAheadAt.length === 0 ? BUS_CREEP_SPEED : 0);
      busTraveledRef.current += busSpeedRef.current * dt;
      busWheelRollRef.current += (busSpeedRef.current / BUS_WHEEL_RADIUS) * dt;

      /**
       * The bus is placed as a chassis, not as a point.
       *
       * `busTraveledRef` is where the *front axle* has got to — the end that follows the
       * road, and the end a bus pulls up to a stop with. The rear axle is dragged a
       * wheelbase behind it along the same path, and the body's heading is the line
       * between the two. That is the whole of the front-wheel-steering model, and it is
       * what gives the back end its off-tracking: through a corner the rear axle is still
       * on the part of the path the front axle left a wheelbase ago, so the tail cuts
       * inside the turn exactly as a long vehicle's does.
       *
       * The routed path runs down the centreline of each road, which would put an
       * 11-metre bus straddling both lanes, so each axle is offset to its own side using
       * the path's heading where that axle sits. Applying the offset here rather than
       * baking it into the path keeps the geometry the ride profile measured — and the
       * arrival test — as the path itself.
       */
      const axlePoint = (traveled: number) => {
        const sample = sampleRide(busPath!, Math.max(0, traveled));
        return {
          x: sample.point.x + Math.cos(sample.heading) * BUS.laneOffset,
          z: sample.point.z - Math.sin(sample.heading) * BUS.laneOffset,
          heading: sample.heading,
        };
      };
      const front = axlePoint(busTraveledRef.current);
      const rear = axlePoint(busTraveledRef.current - BUS_WHEELBASE);
      // Midway between the axles is the body's own origin, which is where the saloon,
      // the doorway and the seat offset are all measured from.
      bus!.position.set((front.x + rear.x) / 2, 0, (front.z + rear.z) / 2);

      const axleSpan = Math.hypot(front.x - rear.x, front.z - rear.z);
      // Pulling away, both axle samples clamp to the start of the path and there is no
      // line between them to take a heading from; hold the one the bus already has.
      const chassisHeading = axleSpan > 0.5
        ? Math.atan2(front.x - rear.x, front.z - rear.z)
        : bus!.rotation.y;
      const blend = 1 - Math.exp(-dt / BUS_HEADING_TAU);
      const yawStep = Math.atan2(Math.sin(chassisHeading - bus!.rotation.y), Math.cos(chassisHeading - bus!.rotation.y)) * blend;
      bus!.rotation.y += yawStep;

      // The front wheels point where the road goes; the body points where the chassis
      // is. The difference between the two is the lock the driver is holding, which is
      // the same quantity a real steering box reads.
      const steerTarget = THREE.MathUtils.clamp(
        Math.atan2(Math.sin(front.heading - bus!.rotation.y), Math.cos(front.heading - bus!.rotation.y)),
        -BUS_MAX_STEER,
        BUS_MAX_STEER,
      );
      busSteerRef.current = THREE.MathUtils.lerp(
        busSteerRef.current,
        steerTarget,
        1 - Math.exp(-dt / BUS_STEER_TAU),
      );

      // Body attitude: lean away from the turn (+x is left, so a left turn rolls
      // negative) and dip the nose under braking. Bigger and slower than a car's,
      // because the mass sits high and the springs are old.
      const yawRate = dt > 0 ? yawStep / dt : 0;
      const acceleration = (busSpeedRef.current - previousSpeed) / Math.max(dt, 1e-4);
      const targetRoll = THREE.MathUtils.clamp(-yawRate * busSpeedRef.current * 0.022, -0.1, 0.1);
      const targetPitch = THREE.MathUtils.clamp(-acceleration * 0.016, -0.05, 0.05);
      const settle = 1 - Math.exp(-dt / BUS_BODY_TAU);
      const lean = busLeanRef.current;
      lean.roll = THREE.MathUtils.lerp(lean.roll, targetRoll, settle);
      lean.pitch = THREE.MathUtils.lerp(lean.pitch, targetPitch, settle);

      // On top of the load-transfer lean, the road itself. Each corner probes the ground
      // under it and the body is carried towards the pose those four probes describe, on
      // its own springs — so a kerb makes the bus dip and rebound rather than snap to a
      // new angle. See busSuspension.ts.
      const cos = Math.cos(bus!.rotation.y);
      const sin = Math.sin(bus!.rotation.y);
      // Height-aware like every other body's ground query: probing raw terrain here sank
      // the bus through any deck its route crosses, because the road elevation profile —
      // which is what makes the deck solid for the car and the pill — was not consulted at
      // all. Capped just above the bus's own current height so the deck it is driving
      // *under* stays overhead instead of becoming the surface its springs chase.
      const cornerHeight = (localX: number, localZ: number) => groundHeightAt(
        bus!.position.x + localX * cos + localZ * sin,
        bus!.position.z - localX * sin + localZ * cos,
        bus!.position.y + BUS_SUSPENSION_STEP_REACH,
      );
      const suspension = advanceBusSuspension(busSuspensionRef.current, {
        frontLeft: cornerHeight(BUS_HALF_TRACK, BUS_FRONT_AXLE_Z),
        frontRight: cornerHeight(-BUS_HALF_TRACK, BUS_FRONT_AXLE_Z),
        rearLeft: cornerHeight(BUS_HALF_TRACK, BUS_REAR_AXLE_Z),
        rearRight: cornerHeight(-BUS_HALF_TRACK, BUS_REAR_AXLE_Z),
      }, dt);
      busSuspensionRef.current = suspension;
      bus!.position.y = suspension.heave.value;
      bus!.rotation.z = lean.roll + suspension.roll.value;
      bus!.rotation.x = lean.pitch + suspension.pitch.value;
      // And the wheels move within their arches to stay on the ground the body has just
      // been carried away from.
      busWheelTravelRef.current = BUS_WHEEL_LAYOUT.map((wheel) => wheelTravel(
        suspension, wheel.x, wheel.z, cornerHeight(wheel.x, wheel.z),
      ));

      // In freecam, WASD/arrows fly the camera instead (see below) — the car and the
      // pill just sit wherever they were left, so they are exactly where you left
      // them if you toggle back out of freecam.
    }
    if (riding) {
      // A top-level `if`, not `else if`: the autopilot block above and this one are not
      // mutually exclusive. While the bus is actually in transit (`traveling`), both
      // must run every tick — the autopilot to move the chassis, this one so the rider
      // can walk the cabin while it moves. Chaining this as `else if` after the
      // autopilot block would make its own `if (traveling && bus)` movement guard below
      // unreachable exactly when it matters, since `traveling` implies `riding` and the
      // outer `if (traveling)` would already have claimed the tick.
      velocityRef.current = 0;
      if (traveling && bus) {
        const throttle = input.brake ? 0 : input.forward;
        const steer = input.turn;
        const pace = (input.boost ? MOVEMENT.personRunSpeed : MOVEMENT.personWalkSpeed) * (throttle < 0 ? 0.55 : 1);
        // Heading is bus-local: 0 faces the front of the bus, independent of the bus's
        // own heading, since the rider walks around the cabin, not around the world.
        personHeadingRef.current += steer * MOVEMENT.personTurnRate * dt;
        const dx = Math.sin(personHeadingRef.current) * pace * throttle * dt;
        const dz = Math.cos(personHeadingRef.current) * pace * throttle * dt;
        const clamped = clampToBusFloor(
          riderLocalOffsetRef.current.x + dx,
          riderLocalOffsetRef.current.z + dz,
        );
        // Seats (task 2) push the free-walking rider back out of the rows the aisle clamp
        // alone doesn't cover — most of the time this is a no-op since clampToBusFloor
        // already keeps the rider within the aisle strip.
        riderLocalOffsetRef.current = resolveAgainstBusSeats(clamped.x, clamped.z, CHARACTER.radius);
      }
      if (bus) {
        const worldPosition = computeRiderWorldPosition(
          bus.position,
          bus.rotation.y,
          riderLocalOffsetRef.current,
        );
        person.position.x = worldPosition.x;
        person.position.z = worldPosition.z;
        person.position.y = BUS_FLOOR_Y;
        person.rotation.y = bus.rotation.y + personHeadingRef.current;
      }
    } else if (control.cameraMode !== 'freecam' && onFoot && !carTransitionRef.current) {
      // On foot: same tank layout as driving (W/S move, A/D turn) so the controls do
      // not change meaning under you, but with no momentum and a much brisker turn.
      // Crouch (task 3) is held, not toggled: it slows movement and shrinks the
      // collision probe for as long as the key is down.
      const crouching = input.crouch;
      const throttle = input.brake ? 0 : input.forward;
      const steer = input.turn;
      const pace = (input.boost ? MOVEMENT.personRunSpeed : MOVEMENT.personWalkSpeed)
        * (throttle < 0 ? 0.55 : 1) * (crouching ? CHARACTER.crouchSpeedMultiplier : 1);
      personHeadingRef.current += steer * MOVEMENT.personTurnRate * dt;
      person.rotation.y = personHeadingRef.current;

      // Water, before the move rather than after it: whether this is a step or a stroke
      // depends on how deep the pill is standing *now*. Never while aboard the bus — the
      // saloon floor is not a surface any water polygon knows about, and a bus stopped on
      // a bridge over the harbour would otherwise have the rider swimming down the aisle.
      const personSwim = personSwimRef.current;
      const personSurface = insideBusRef.current
        ? { standY: BUS_FLOOR_Y, waterY: null }
        : surfaceUnderBody(person.position.x, person.position.z, person.position.y);
      const personWaterY = personSurface.waterY;
      const stroke = stepWaterMovement(
        personSwim, person.position, personHeadingRef.current, throttle, pace,
        personWaterY, personSurface.standY, dt,
      );
      const desiredPersonX = stroke.x;
      const desiredPersonZ = stroke.z;

      // Sweep-and-slide against buildings/props (task 1) — skipped inside the bus, where
      // the shell/seat clamp just below is the collision instead. Reports back whether a
      // low obstacle should be mantled or a marked-climbable one scaled (task 3).
      let personMantleTop: number | null = null;
      let personClimbTop: number | null = null;
      if (!insideBusRef.current && physics) {
        // No climbing out of the water onto a wall, and no mantling: both resolve against
        // an obstacle's *top*, which is above the swimmer, and a stroke into a quay would
        // otherwise hoist the pill onto it rather than stopping it against it.
        const attemptClimb = throttle > 0 && input.jump && !stroke.swimming;
        const colliderOffsetY = crouching ? CHARACTER.crouchColliderHeight : CHARACTER.standColliderHeight;
        const resolved = resolveCharacterMovement(
          physics, person.position.y, desiredPersonX, desiredPersonZ,
          CHARACTER.radius, colliderOffsetY, CATEGORY_BUILDINGS | CATEGORY_PROPS,
          stroke.swimming ? 0 : CHARACTER.mantleHeight, attemptClimb,
        );
        person.position.x = resolved.x;
        person.position.z = resolved.z;
        personMantleTop = resolved.mantleTop;
        personClimbTop = resolved.climbTop;
      } else {
        person.position.x = desiredPersonX;
        person.position.z = desiredPersonZ;
      }

      if (insideBusRef.current && bus) {
        // Keep the pill inside the shell, in the bus's own frame — it can be parked
        // at any angle. The doorway is the one gap in the kerb-side wall, and the
        // walkable strip away from it is narrowed to the aisle (task 2) — seats
        // (resolveAgainstBusSeats) take the rest of the width.
        const cos = Math.cos(bus.rotation.y);
        const sin = Math.sin(bus.rotation.y);
        const dx = person.position.x - bus.position.x;
        const dz = person.position.z - bus.position.z;
        let localX = dx * cos - dz * sin;
        const localZ = THREE.MathUtils.clamp(dx * sin + dz * cos, -BUS_INTERIOR_HALF_LENGTH, BUS_INTERIOR_HALF_LENGTH);
        const inDoorway = localZ > BUS_DOOR_BACK_Z && localZ < BUS_DOOR_FRONT_Z;
        localX = Math.min(localX, BUS_AISLE_HALF_WIDTH);
        if (!inDoorway) localX = Math.max(localX, -BUS_AISLE_HALF_WIDTH);
        // Clear of the door line and out on the street: stop constraining, and let
        // the ground target below drop from the saloon floor to the road. Measured
        // against the old full-width threshold, not the aisle — the doorway itself is
        // not aisle-clamped, so this only ever fires once the pill is genuinely outside.
        if (localX < -BUS_INTERIOR_HALF_WIDTH - 0.6) insideBusRef.current = false;
        const seatResolved = resolveAgainstBusSeats(localX, localZ, CHARACTER.radius);
        person.position.x = bus.position.x + seatResolved.x * cos + seatResolved.z * sin;
        person.position.z = bus.position.z - seatResolved.x * sin + seatResolved.z * cos;
      }

      // A small vertical bob while moving — without it the pill slides around like a
      // prop rather than reading as something walking. The ground it bobs above is
      // the saloon floor while aboard, so stepping out is a short drop, not a snap.
      walkCycleRef.current += throttle !== 0 ? pace * 1.6 * dt : 0;
      const bob = throttle !== 0 ? Math.abs(Math.sin(walkCycleRef.current)) * 0.05 : 0;
      // On foot the pill reads the same ground the wheels do (routed through the physics
      // world's own groundHeightAt, task 4) — it used to be pinned to y=0, which sank it
      // to the knees in every wood it walked into, and read raw terrain height only,
      // which is what dropped it through an elevated bridge deck to the ground below.
      // Resolved at the position collision actually left the pill at, not the one it
      // started the tick on: standing height is what the vertical step below settles onto.
      let groundY = insideBusRef.current
        ? BUS_FLOOR_Y
        : surfaceUnderBody(person.position.x, person.position.z, person.position.y).standY;
      // Pressed against a low obstacle: pull the ground target up to its top so the
      // vertical-motion step below carries the pill straight onto it (mantle).
      if (!insideBusRef.current && personMantleTop !== null) groundY = Math.max(groundY, personMantleTop);

      const previousPersonY = person.position.y;
      const personVertical = personVerticalRef.current;
      if (stroke.swimming && personWaterY !== null) {
        // Floating: the surface is the ground, and gravity, jumping and the walk bob all
        // stop applying. Left `grounded`, so the tick the pill stands up in the shallows
        // settles onto the beach instead of starting a fall from the water line.
        person.position.y = swimBodyY(person.position.y, personWaterY, dt);
        personVertical.verticalVelocity = 0;
        personVertical.grounded = true;
      } else if (personClimbTop !== null) {
        // Climbing a marked surface (a tree, a building edge): rise at a fixed speed,
        // capped either by the surface's own top or a scoped maximum climb height.
        const climbTarget = Math.min(personClimbTop, groundY + CHARACTER.maxClimbHeight);
        person.position.y = Math.min(person.position.y + CHARACTER.climbSpeed * dt, climbTarget);
        personVertical.verticalVelocity = 0;
        personVertical.grounded = person.position.y >= climbTarget - 0.02;
      } else if (personVertical.grounded) {
        if (input.jump && !crouching) {
          personVertical.verticalVelocity = CHARACTER.jumpVelocity;
          personVertical.grounded = false;
        } else {
          person.position.y = THREE.MathUtils.lerp(person.position.y, groundY + bob, 1 - Math.exp(-dt / CHARACTER.groundSnapTau));
        }
      }
      if (!personVertical.grounded && personClimbTop === null && !stroke.swimming) {
        personVertical.verticalVelocity -= CHARACTER.gravity * dt;
        person.position.y += personVertical.verticalVelocity * dt;
        if (person.position.y <= groundY) {
          person.position.y = groundY;
          personVertical.verticalVelocity = 0;
          personVertical.grounded = true;
        }
      }
      if (physics && !insideBusRef.current) {
        const resolvedY = resolveCharacterCeiling(physics, person.position.x, person.position.z,
          previousPersonY, person.position.y, crouching ? 1 : 1.7, CHARACTER.radius);
        if (resolvedY < person.position.y) personVertical.verticalVelocity = Math.min(0, personVertical.verticalVelocity);
        person.position.y = resolvedY;
      }
      velocityRef.current = stroke.speed;
    } else if (control.cameraMode !== 'freecam' && onBlob) {
      // Two selectable input schemes for the blob (see playerInput.ts's
      // BlobControlScheme, gameplayConfig.BLOBBY, and the toggle in App.tsx). Both funnel
      // down to the same three things the rest of this block — collision, ground, jump/
      // crouch/climb, animation — doesn't care which scheme produced: a pace, how much of
      // that pace to actually apply this tick (0 when idle), and the world heading to
      // move in. No bus-interior clamp either way — the blob never boards anything.
      const crouching = input.crouch;
      let pace: number;
      let moveMagnitude: number;
      let running: boolean;
      let headingForMotion: number;

      if (control.blobControlScheme === 'blobby') {
        // The scheme itself is resolved in blobControls.ts, which documents what it keeps
        // from docs/misc/blobby's CharacterController.jsx and what it deliberately changes.
        // What stays here is only what needs the scene: the pointer's offset within this
        // canvas, and writing the result onto the model.
        if (blobLastSchemeRef.current !== 'blobby') {
          // Just switched in: start the orbit from wherever the blob already faces, so
          // the camera does not snap on the first frame under the new scheme.
          blobCameraYawRef.current = blobHeadingRef.current;
          blobFacingOffsetRef.current = 0;
        }
        blobLastSchemeRef.current = 'blobby';

        const pointer = control.blobPointer;
        const resolved = resolveBlobbyControl(
          {
            turn: input.turn,
            forward: input.forward,
            boost: input.boost,
            pointer: pointer
              ? pointerViewOffset(pointer, gl.domElement.getBoundingClientRect())
              : null,
          },
          {
            cameraYaw: blobCameraYawRef.current,
            facingOffset: blobFacingOffsetRef.current,
            heading: blobHeadingRef.current,
          },
          dt,
        );
        blobCameraYawRef.current = resolved.cameraYaw;
        blobFacingOffsetRef.current = resolved.facingOffset;
        blobHeadingRef.current = resolved.heading;
        blob.rotation.y = resolved.heading;

        running = resolved.running;
        moveMagnitude = resolved.moveMagnitude;
        headingForMotion = resolved.headingForMotion;
        pace = (running ? MOVEMENT.blobRunSpeed : MOVEMENT.blobWalkSpeed) * (crouching ? CHARACTER.crouchSpeedMultiplier : 1);
      } else {
        blobLastSchemeRef.current = 'direct';
        // This project's usual tank layout: WASD/arrows map straight onto forward/turn,
        // same as the pill on foot, just with the blob's own pace and turn rate.
        let throttle = input.brake ? 0 : input.forward;
        let steer = input.turn;
        running = input.boost && throttle > 0;
        // Click-to-move: while a pointer is held, its offset from the view's centre
        // stands in for the WASD axes — drag up to walk forward, drag to a side to turn
        // that way, far enough from centre breaks into a run. A small dead zone around
        // centre keeps a barely-trembling hold from reading as full turn.
        const pointer = control.blobPointer;
        const drag = pointer ? pointerViewOffset(pointer, gl.domElement.getBoundingClientRect()) : null;
        if (drag) {
          const deadZone = 0.08;
          steer = Math.abs(drag.x) > deadZone ? -drag.x : 0;
          throttle = Math.abs(drag.y) > deadZone ? drag.y : 0;
          running = Math.hypot(drag.x, drag.y) > 0.6;
        }
        pace = (running ? MOVEMENT.blobRunSpeed : MOVEMENT.blobWalkSpeed)
          * (throttle < 0 ? 0.55 : 1) * (crouching ? CHARACTER.crouchSpeedMultiplier : 1);
        moveMagnitude = Math.abs(throttle);
        blobHeadingRef.current += steer * MOVEMENT.blobTurnRate * dt;
        blob.rotation.y = blobHeadingRef.current;
        headingForMotion = blobHeadingRef.current;
      }

      // The blob swims on exactly the same terms as the pill — it is the same player in a
      // different body, and a form that walked along the seabed while the other swam would
      // make the toggle a way around the water. `moveMagnitude` is this scheme's throttle.
      const blobSwim = blobSwimRef.current;
      const blobSurface = surfaceUnderBody(blob.position.x, blob.position.z, blob.position.y);
      const blobWaterY = blobSurface.waterY;
      const blobStroke = stepWaterMovement(
        blobSwim, blob.position, headingForMotion, moveMagnitude, pace,
        blobWaterY, blobSurface.standY, dt,
      );
      const desiredBlobX = blobStroke.x;
      const desiredBlobZ = blobStroke.z;

      let blobMantleTop: number | null = null;
      let blobClimbTop: number | null = null;
      if (physics) {
        const attemptClimb = moveMagnitude > 0 && input.jump && !blobStroke.swimming;
        const colliderOffsetY = crouching ? CHARACTER.crouchColliderHeight : CHARACTER.standColliderHeight;
        const resolved = resolveCharacterMovement(
          physics, blob.position.y, desiredBlobX, desiredBlobZ,
          CHARACTER.radius, colliderOffsetY, CATEGORY_BUILDINGS | CATEGORY_PROPS,
          blobStroke.swimming ? 0 : CHARACTER.mantleHeight, attemptClimb,
        );
        blob.position.x = resolved.x;
        blob.position.z = resolved.z;
        blobMantleTop = resolved.mantleTop;
        blobClimbTop = resolved.climbTop;
      } else {
        blob.position.x = desiredBlobX;
        blob.position.z = desiredBlobZ;
      }

      let blobGroundY = surfaceUnderBody(blob.position.x, blob.position.z, blob.position.y).standY;
      if (blobMantleTop !== null) blobGroundY = Math.max(blobGroundY, blobMantleTop);

      const previousBlobY = blob.position.y;
      const blobVertical = blobVerticalRef.current;
      if (blobStroke.swimming && blobWaterY !== null) {
        blob.position.y = swimBodyY(blob.position.y, blobWaterY, dt);
        blobVertical.verticalVelocity = 0;
        blobVertical.grounded = true;
      } else if (blobClimbTop !== null) {
        const climbTarget = Math.min(blobClimbTop, blobGroundY + CHARACTER.maxClimbHeight);
        blob.position.y = Math.min(blob.position.y + CHARACTER.climbSpeed * dt, climbTarget);
        blobVertical.verticalVelocity = 0;
        blobVertical.grounded = blob.position.y >= climbTarget - 0.02;
      } else if (blobVertical.grounded) {
        if (input.jump && !crouching) {
          blobVertical.verticalVelocity = CHARACTER.jumpVelocity;
          blobVertical.grounded = false;
        } else {
          blob.position.y = blobGroundY;
        }
      }
      if (!blobVertical.grounded && blobClimbTop === null && !blobStroke.swimming) {
        blobVertical.verticalVelocity -= CHARACTER.gravity * dt;
        blob.position.y += blobVertical.verticalVelocity * dt;
        if (blob.position.y <= blobGroundY) {
          blob.position.y = blobGroundY;
          blobVertical.verticalVelocity = 0;
          blobVertical.grounded = true;
        }
      }
      if (physics) {
        const resolvedY = resolveCharacterCeiling(physics, blob.position.x, blob.position.z,
          previousBlobY, blob.position.y, crouching ? 1 : 1.7, CHARACTER.radius);
        if (resolvedY < blob.position.y) blobVertical.verticalVelocity = Math.min(0, blobVertical.verticalVelocity);
        blob.position.y = resolvedY;
      }
      velocityRef.current = blobStroke.speed;
      const model = blobModelRef.current;
      if (model) {
        // Swimming borrows the walk cycle rather than getting its own: the blob's rig has
        // three clips, and a stroke reads far better as a slow walk than as an idle pose
        // gliding across the water.
        model.setAnimation(moveMagnitude < 0.05 && !blobStroke.swimming ? 'idle' : running && !blobStroke.swimming ? 'run' : 'walk');
        model.update(dt);
      }
    } else if (control.cameraMode !== 'freecam' && onHorse) {
      // Gait selection reuses the same forward/boost/crouch axes the pill and blob read
      // (see playerInput.ts) rather than a parallel input system: not pressed forward is
      // 'stand' (a horse does not reverse), plain forward is 'trot', forward+crouch is
      // the deliberate 'walk', forward+boost is 'canter'. Turn feeds straight into
      // stepHorse's own turn-rate integration.
      const throttle = input.brake ? 0 : input.forward;
      const gait: HorseGait = throttle <= 0.05
        ? 'stand'
        : input.boost ? 'canter' : input.crouch ? 'walk' : 'trot';
      const groundAt = (point: { x: number; z: number }) => physics
        ? physics.groundHeightAt(point.x, point.z, horse.position.y + 0.3)
        : terrainHeightAtXZIndexed(point.x, point.z, terrainIndexRef.current);
      horseStateRef.current = stepHorse(
        horseStateRef.current,
        { gait, turn: input.turn },
        dt,
        groundAt,
        // The horse wades the shallows and refuses the rest — see HORSE_MAX_WADE_DEPTH.
        // Without this it walked along the seabed, which the implied bed made visible.
        (point) => {
          const { standY, waterY } = surfaceUnderBody(point.x, point.z, horse.position.y);
          return waterY === null || waterY - standY <= HORSE_MAX_WADE_DEPTH;
        },
      );
      const hs = horseStateRef.current;
      horse.position.set(hs.x, hs.y, hs.z);
      horse.rotation.y = hs.heading;
      velocityRef.current = GAIT_SPEED_MPS[hs.gait];
      const model = horseModelRef.current;
      if (model) model.update(dt, GAIT_SPEED_MPS[hs.gait]);
    } else if (control.cameraMode !== 'freecam') {
      // The car is no longer integrated here at all: input becomes engine, brake and
      // steering demands, and where the car ends up is whatever four tyres and four
      // springs make of them in the physics step below.
      const vehicle = carVehicleRef.current;
      const drowning = !driveControlEnabled(carWaterRef.current.phase);
      if (vehicle) {
        applyCarControls(vehicle, {
          // A flooded engine takes no more input, and the wheel goes with it (backlog
          // item 10's "removes drive control"). The call still happens: it is also what
          // applies aerodynamic drag and zeroes last tick's engine force, and skipping it
          // would leave the car coasting on whatever demand it was last given.
          forward: drowning ? 0 : input.forward,
          turn: drowning ? 0 : input.turn,
          brake: drowning ? false : input.brake,
          boost: drowning ? false : input.boost,
        }, dt);
        if (drowning) {
          // "Damps motion": water is not a road, and a dead car should stop in it rather
          // than glide on. Applied to the chassis body directly because there is no
          // control input left to express it through.
          const damping = driveVelocityDamping(carWaterRef.current.phase);
          vehicle.chassis.linearVelocity.multiplyScalar(damping);
          vehicle.chassis.angularVelocity.multiplyScalar(damping);
        }
      }
      brakingRef.current = drowning ? false : isCarBraking(input.brake, input.forward, velocityRef.current);
    }

    /**
     * The car in water, every tick and in every mode: a car pushed in, or left in, sinks
     * exactly like one that was driven in. Deliberately outside the drive branch above,
     * which only runs while someone is at the wheel — and the interesting half of this
     * sequence happens after the player has been thrown out of it.
     */
    {
      const samples = carFootprintSamples(car.position, car.rotation.y, CAR_HALF_WHEELBASE, CAR_HALF_TRACK);
      // Measured against the floorpan, not the road: a car is in the water once the water
      // is deeper than the floor it would come in over, so the shallow rim of a shoreline
      // does not drown a car driving past it.
      const submerged = countSubmergedSamples(samples, (x, z) => surfaceUnderBody(x, z, car.position.y).waterY === null
        ? null : waterDepthAt(x, z), CAR_FLOOR_HEIGHT);
      const previousPhase = carWaterRef.current.phase;
      carWaterRef.current = stepCarWaterState(carWaterRef.current, submerged, samples.length, dt);
      const water = carWaterRef.current;

      if (previousPhase === 'dry' && water.phase === 'entering') {
        carSinkSurfaceRef.current = waterSurfaceAt(car.position.x, car.position.z) ?? car.position.y;
      }
      if (shouldEjectOccupant(previousPhase, water.phase) && control.mode === 'car') {
        ejectFromSinkingCarRef.current();
      }
      if (water.phase === 'sinking' || water.phase === 'submerged') {
        // Nobody is driving a sinking car (the ejection above is what guarantees it), so
        // the group is authoritative again and syncCarBodyFromGroup pins the body to it —
        // which is what lets the car be placed straight down rather than fought for by a
        // suspension that has no ground to push against.
        car.position.y = carSinkSurfaceRef.current - water.sinkDepth;
        // Nose first, as a car with its engine over the front axle goes down.
        car.rotation.x = SINKING_CAR_PITCH * (water.sinkDepth / CAR_WATER_FULL_SINK_DEPTH);
      }
    }

    // Moved into the fixed-tick loop (rather than left with the rest of the door/steer
    // visuals below) because doorOpenFraction feeds straight back into this same tick's
    // advanceBusLifecycle call just below: under catch-up, the door has to actually
    // finish opening tick by tick for the door-opening -> alighting transition to land in
    // the right tick instead of one real frame later than the rest of the catch-up.
    if (busModelRef.current) {
      busDoorFractionRef.current = THREE.MathUtils.lerp(
        busDoorFractionRef.current,
        busDoorOpenRef.current ? 1 : 0,
        1 - Math.exp(-dt / BUS_DOOR_TAU),
      );
      // The wheels are pointed straight whenever the bus is not running a route, so a
      // parked one is not left sitting on half a lock from the last corner it took — and
      // the same goes for the suspension, which would otherwise hold the travel it had at
      // the last corner of the last ride for the whole time the bus is parked.
      if (!traveling) {
        busSteerRef.current = THREE.MathUtils.lerp(busSteerRef.current, 0, 1 - Math.exp(-dt / BUS_STEER_TAU));
        busWheelTravelRef.current = busWheelTravelRef.current.map((travel) => travel * Math.exp(-dt / 0.3));
      }
    }

    if (carModelRef.current) {
      // Only the branch above ever puts anyone at the wheel. Riding the bus, walking, or
      // flying the freecam leaves a parked car, and a parked car is not on the brakes
      // however stale brakingRef happens to be.
      const driving = !riding && !onFoot && control.cameraMode !== 'freecam' && !carIsSinking(carWaterRef.current.phase);
      setCarLights(carModelRef.current, {
        nightFactor: nightFactorRef.current,
        braking: driving && brakingRef.current,
        reversing: driving && velocityRef.current < -0.2,
      });
    }

    let lifecycle = busLifecycleRef.current;
    if (
      lifecycle.phase === 'driving'
      && busProfile
      && busProfile.length - busTraveledRef.current <= RIDE_ARRIVAL_EPSILON
    ) {
      busStopAtRef.current = busProfile.length;
      lifecycle = advanceBusLifecycle(lifecycle, {
        dt: 0,
        speed: busSpeedRef.current,
        doorOpenFraction: 0,
        stopReached: false,
        requestedStop: true,
        busOffscreen: false,
      });
      setHintRef.current('PULLING IN…');
    }

    if (lifecycle.phase === 'departing' && bus) {
      busSpeedRef.current = advanceRideSpeed(busSpeedRef.current, 12, dt, 0);
      bus.position.x += Math.sin(bus.rotation.y) * busSpeedRef.current * dt;
      bus.position.z += Math.cos(bus.rotation.y) * busSpeedRef.current * dt;
    }

    const stopReached = lifecycle.phase === 'braking'
      && busStopAtRef.current !== null
      && (
        busTraveledRef.current >= busStopAtRef.current - 0.05
        || busSpeedRef.current <= 0.02
      );
    if (stopReached) busSpeedRef.current = 0;
    const doorOpenFraction = busDoorFractionRef.current;
    const previousPhase = lifecycle.phase;
    const nextLifecycle = advanceBusLifecycle(lifecycle, {
      dt,
      speed: busSpeedRef.current,
      doorOpenFraction,
      stopReached,
      requestedStop: false,
      busOffscreen: false,
    });
    busLifecycleRef.current = nextLifecycle;

    if (nextLifecycle.phase !== previousPhase) {
      if (nextLifecycle.phase === 'door-opening') {
        busDoorOpenRef.current = true;
        setHintRef.current('GETTING OFF…');
      } else if (nextLifecycle.phase === 'alighting') {
        alightRef.current();
      } else if (nextLifecycle.phase === 'waiting') {
        insideBusRef.current = false;
        setModeRef.current('foot');
      } else if (nextLifecycle.phase === 'departing') {
        busDoorOpenRef.current = false;
        busSpeedRef.current = 0;
      } else if (nextLifecycle.phase === 'hidden') {
        if (bus) bus.visible = false;
        busPathRef.current = null;
        busProfileRef.current = null;
        busTraveledRef.current = 0;
        busSpeedRef.current = 0;
        busStopAtRef.current = null;
        busSignalStopsRef.current = [];
        busDoorOpenRef.current = false;
        // The next ride is a different service; nothing from this one's signs carries over.
        lastBusStreetRef.current = null;
        lastBusDestinationRef.current = null;
      }
    }

    /**
     * Getting into and out of the car.
     *
     * While a transition is live the pill's pose is not the movement code's to write —
     * the state machine owns it, in car space, and this converts one frame of that into
     * a world pose. The machine is only asked whether the player wants to move so it can
     * let them change their mind at the door; every other input is already suppressed by
     * `inputPaused`.
     */
    const carTransition = carTransitionRef.current;
    if (carTransition) {
      // Read past `inputPaused` deliberately. The pause is what stops the player steering
      // a body that is halfway into a car; it must not also stop them being *heard* asking
      // to walk away, which is the one input the sequence still answers.
      const raw = control.input.snapshot();
      const pose = advanceVehicleTransition(carTransition, dt, {
        wantsToMove: Math.abs(raw.forward) > 0.2 || Math.abs(raw.turn) > 0.2,
      });
      // Car space to world, with the car's pose *this* frame: the sequence is computed in
      // the car's frame precisely so that a car which rolls or turns mid-transition carries
      // the body with it (vehicleEntry.ts).
      const worldPose = pose.position.clone()
        .applyAxisAngle(WORLD_UP, car.rotation.y)
        .add(car.position);
      person.position.copy(worldPose);
      person.rotation.y = car.rotation.y + pose.yaw;
      personHeadingRef.current = person.rotation.y;
      person.visible = true;

      if (pose.finished) {
        carTransitionRef.current = null;
        controlRef.current.inputPaused = false;
        if (pose.phase === 'seated') {
          person.visible = false;
          headingRef.current = car.rotation.y;
          setModeRef.current('car');
        } else {
          // Back on their feet beside the car — either because they got out, or because
          // they asked to walk away while the door was still swinging. Either way the
          // ground under them has not been checked since the sequence began (the car may
          // have rolled), so the next tick's ground query settles them rather than this
          // one asserting a height.
          personVerticalRef.current.grounded = false;
          if (carTransition.stumbled) {
            pushLog('info', 'car', 'stepped out of a moving car');
          }
        }
      }
    }

    if (nextLifecycle.phase === 'alighting' && bus) {
      const local = sampleAlightPath(nextLifecycle.alightProgress, alightStartLocalRef.current);
      const cos = Math.cos(bus.rotation.y);
      const sin = Math.sin(bus.rotation.y);
      person.position.x = bus.position.x + local.x * cos + local.z * sin;
      person.position.z = bus.position.z - local.x * sin + local.z * cos;
      person.position.y = BUS_FLOOR_Y * (1 - nextLifecycle.alightProgress);
      person.rotation.y = bus.rotation.y;
      personHeadingRef.current = bus.rotation.y;
    }
    /**
     * One physics tick, at the end of the simulation tick that set everything up.
     *
     * The bus and the pill are written into their bodies here rather than being driven by
     * them: their pose comes from the route and the walk controller, and the body carries
     * it plus the velocity that pose change implies, so both shove things with the right
     * momentum without the solver ever moving them. The car is the opposite — its body is
     * the authority, and the rendered car is placed from it afterwards.
     */
    const carVehicle = carVehicleRef.current;
    if (physics && carVehicle) {
      // A sinking car is not driven, whatever mode the player was in when this tick
      // started: the ejection above only reaches `onFoot` on the *next* step, and one tick
      // of the solver putting the chassis back on its springs would undo the sink.
      const driving = !riding && !onFoot && control.cameraMode !== 'freecam' && !carIsSinking(carWaterRef.current.phase);
      // Not driving: the car is parked wherever the game last put it, so the body is
      // pinned back to it every tick. This is also what makes a teleport, a spawn or
      // being set down beside the bus reach the physics world with no extra plumbing.
      if (!driving) syncCarBodyFromGroup(carVehicle, car);

      /**
       * Carries a positionally-driven body to where its model now is, giving it the
       * velocity that move implies so it hits things with the right momentum.
       *
       * A move larger than SIMULATION.drivenBodyTeleport is read as a teleport rather than as
       * travel — a spawn, a mode change, the bus appearing for a new ride — and arrives
       * with no velocity at all. Without that, the first tick of a ride would hand a
       * twelve-tonne body a few thousand metres per second and flatten a whole district.
       */
      const busBody = busBodyRef.current;
      // The bus body's colliders are measured from the road, so it takes the bus's
      // ground position rather than the height its suspension has carried it to.
      if (busBody && bus) carryDrivenBody(busBody, bus, previousBusPointRef.current, dt);
      const personBody = personBodyRef.current;
      if (personBody) carryDrivenBody(personBody, person, previousPersonPointRef.current, dt);

      physics.step(dt);

      const carModel = carModelRef.current;
      if (carModel) {
        if (driving) {
          syncCarPose(carModel, carVehicle);
          // The rest of the game still asks the car where it is pointing and how fast it
          // is going through these two; they are now readouts of the simulation rather
          // than the state the simulation is kept in.
          headingRef.current = car.rotation.y;
          velocityRef.current = carVehicle.forwardSpeed();
        }
        // Whether or not anyone is driving it, a parked car still stands on its springs.
        syncCarWheels(carModel, carVehicle);
      }
    }
    } // end fixed-tick loop

    // The enter-the-car prompt. Proximity is re-tested every frame but setHint only
    // calls back on a change, so this costs one hypot and a comparison per frame.
    // The door and the pill's fade run regardless of mode: both are still animating
    // for a second or so after the transition that started them.
    const busModel = busModelRef.current;
    if (busModel) {
      // The lerps that drive these values now run inside the fixed-tick loop above
      // (see there for why); this just applies whatever they last settled on.
      setBusDoorOpen(busModel, busDoorFractionRef.current);
      setBusSteer(busModel, busSteerRef.current);
      setBusWheelRoll(busModel, busWheelRollRef.current);
      setBusWheelTravel(busModel, busWheelTravelRef.current);
    }

    /**
     * The physics world's own per-frame work, outside the fixed tick: which props have
     * bodies (a function of where the player is, not of how many ticks have passed),
     * where the disturbed ones have got to, and the debug overlay.
     */
    const physicsWorld = physicsRef.current;
    const propLayer = propLayerRef.current;
    if (physicsWorld && propLayer) {
      const currentProps = world.getProps();
      // A rebuilt world returns a new array; the props the layer is holding refer to
      // instanced meshes that no longer exist, so the whole set is adopted afresh.
      if (currentProps !== adoptedPropsRef.current) {
        adoptedPropsRef.current = currentProps;
        propLayer.setProps(currentProps);
      }
      const focus = control.mode === 'bus' && bus ? bus.position
        : control.mode === 'foot' ? person.position
          : control.mode === 'blob' ? blob.position
            : control.mode === 'horse' && horse ? horse.position
              : car.position;
      propLayer.update(focus);
      propLayer.sync();
      buildingLayerRef.current?.update(focus);
      // Reused rather than rebuilt per frame — the overlay is usually off, and this ran
      // before update could bail on that.
      debugVehicles.length = 0;
      if (carVehicleRef.current) debugVehicles.push(carVehicleRef.current);
      physicsDebugRef.current?.update(physicsWorld, debugVehicles, focus, SIMULATION.debugRadius);
    }
    // Library spawns animate on the real per-frame delta, not the fixed tick: they carry
    // whatever clips their GLB shipped with and nothing simulates against them, so there is
    // no determinism to protect — the same reason the bus door and the pill's fade sit out
    // here rather than inside the fixed loop.
    for (const spawned of spawnedModelsRef.current) spawned.update(dt);

    if (person.visible && personFadeRef.current < 1) {
      personFadeRef.current = Math.min(1, personFadeRef.current + dt / PERSON_FADE.fadeSeconds);
      const opacity = personFadeRef.current * PERSON_OPACITY;
      for (const material of personMaterialsRef.current) material.opacity = opacity;
      // A transparent caster still writes a fully opaque silhouette into the shadow map,
      // so a pill at opacity 0 laid a solid black capsule on the pavement with nothing
      // standing over it. It starts casting once it is actually there to be seen.
      const casts = personFadeRef.current >= PERSON_FADE.shadowFade;
      if (casts !== personCastsShadowRef.current) {
        personCastsShadowRef.current = casts;
        shadowNeedsUpdateRef.current = true;
      }
      person.traverse((object) => {
        if (object instanceof THREE.Mesh) object.castShadow = casts;
      });
    }

    const currentPhase = busLifecycleRef.current.phase;
    const currentlyOnFoot = control.mode === 'foot';
    if (currentPhase === 'driving') {
      setHintRef.current('PRESS B TO GET OFF');
    } else if (currentPhase === 'braking') {
      setHintRef.current('PULLING IN…');
    } else if (currentPhase === 'door-opening' || currentPhase === 'alighting') {
      setHintRef.current('GETTING OFF…');
    } else if (control.mode === 'car' && carWaterRef.current.phase !== 'dry') {
      // The one warning the player gets. Ahead of the mode prompts below because there is
      // nothing else worth saying while the footwell is filling up.
      setHintRef.current(driveControlEnabled(carWaterRef.current.phase) ? 'WATER — BACK OUT' : 'ENGINE DEAD');
    } else if (currentlyOnFoot && personSwimRef.current.swimming) {
      setHintRef.current('SWIM FOR SHORE');
    } else if (control.mode === 'horse') {
      setHintRef.current('E · DISMOUNT');
    } else if (currentlyOnFoot) {
      // Who, if anyone, is close enough to talk to. Recomputed every frame but only
      // pushed to the HUD on a change, the same way the enter-the-car prompt is.
      const camp = campRef.current;
      const listener = camp
        ? nearestListener(
          campSeatsRef.current,
          camp.group.position.x,
          camp.group.position.z,
          person.position.x,
          person.position.z,
        )
        : -1;
      campListenerRef.current = listener;
      if (listener >= 0) {
        setHintRef.current('E · LISTEN');
      } else if (horseReadyRef.current && canMountHorse(horseStateRef.current, { x: person.position.x, z: person.position.z })) {
        setHintRef.current('E · MOUNT HORSE');
      } else {
        const toCar = Math.hypot(person.position.x - car.position.x, person.position.z - car.position.z);
        setHintRef.current(carSpawnedRef.current && toCar <= CAR_ENTER_RADIUS ? 'E · ENTER CAR' : null);
      }
    } else {
      campListenerRef.current = -1;
      setHintRef.current(null);
    }

    // Every system below (sun/shadow frustum, world streaming anchor, sky dome
    // anchor, camera, nearby scan) follows whichever body the player currently is
    // — a generalization of the previously car-only logic.
    const followingAlight = currentPhase === 'alighting';
    const currentlyRiding = control.mode === 'bus' && currentPhase !== 'hidden' && !!bus;
    const boardedWalking = currentlyRiding && (currentPhase === 'driving' || currentPhase === 'braking');
    const currentlyBlob = control.mode === 'blob';
    const currentlyHorse = control.mode === 'horse';
    const active = followingAlight || boardedWalking ? person
      : currentlyRiding ? bus!
        : currentlyOnFoot ? person
          : currentlyBlob ? blob
            : currentlyHorse ? horse : car;
    const activeHeading = followingAlight || boardedWalking
      ? personHeadingRef.current
      : currentlyRiding
        ? bus!.rotation.y
        : currentlyOnFoot
          ? personHeadingRef.current
          : currentlyBlob
            // 'blobby' orbits the camera on its own axis, independent of which way the
            // blob model itself is currently facing (see blobCameraYawRef above); the
            // 'direct' scheme has always kept the two the same.
            ? (control.blobControlScheme === 'blobby' ? blobCameraYawRef.current : blobHeadingRef.current)
            : currentlyHorse
              ? horseStateRef.current.heading
              : headingRef.current;
    const rig = boardedWalking ? INTERIOR_RIG
      : followingAlight || currentlyOnFoot || currentlyBlob ? FOOT_RIG
        : currentlyHorse ? HORSE_RIG : VEHICLE_RIG;

    // The shadow frustum reaches barely a hundred metres, so it has to sit under whatever
    // is actually on screen. That is the active body in every rig that frames it — but
    // freecam detaches the camera entirely, and following the parked car from a viewpoint
    // half a kilometre away left the whole visible city unshadowed.
    const shadowFocus = control.cameraMode === 'freecam' ? freecamPositionRef.current : active.position;
    // Snapped to the shadow map's own texel grid rather than tracking the focus exactly:
    // a frustum that slides by a fraction of a texel each frame makes the whole shadow
    // map re-sample every surface slightly differently, which reads as bands of acne
    // crawling along walls and road as you drive. See shadowSnap.
    snapShadowTarget(
      shadowFocus,
      sunOffsetVecRef.current,
      shadowTexelRef.current,
      shadowCandidateRef.current,
    );
    // Baking: renderer.shadowMap.autoUpdate is off (see Canvas onCreated), so the shadow
    // pass only re-renders when this block asks for it. Three re-renders shadows from
    // the light/shadow-camera transform at the moment of that render, so the light must
    // stay frozen on whatever was last actually rendered — moving sun.position/target
    // without also re-rendering would desync the shadow map from the frustum that
    // produced it, showing shadows offset from where receivers expect them. Below the
    // recentre threshold (and with nothing else dirtying it — time of day, quality, or
    // geometry streaming in/out of range) both stay put and the frame reuses last
    // frame's shadow map outright.
    const streaming = world.isBuilding();
    const streamingSettled = shadowStreamingRef.current && !streaming;
    shadowStreamingRef.current = streaming;
    const movedEnough = shadowTargetRef.current.distanceToSquared(shadowCandidateRef.current)
      > SHADOW.recentreThresholdMeters * SHADOW.recentreThresholdMeters;
    if (shadowNeedsUpdateRef.current || streaming || streamingSettled || movedEnough) {
      shadowTargetRef.current.copy(shadowCandidateRef.current);
      sun.position.copy(shadowTargetRef.current).add(sunOffsetVecRef.current);
      sun.target.position.copy(shadowTargetRef.current);
      state.gl.shadowMap.needsUpdate = true;
      shadowNeedsUpdateRef.current = false;
    }

    const flashlight = flashlightRef.current;
    if (flashlight) {
      const wanted = control.flashlight ? FLASHLIGHT_INTENSITY : 0;
      // Eased rather than switched, so the torch reads as being brought up rather than
      // as the world changing exposure on a cut.
      flashlight.intensity = THREE.MathUtils.lerp(flashlight.intensity, wanted, 1 - Math.exp(-dt / FLASHLIGHT_TAU));
      if (flashlight.intensity > 0.01) {
        state.camera.getWorldDirection(flashlightAimRef.current);
        flashlight.position.copy(state.camera.position);
        flashlight.target.position.copy(state.camera.position)
          .addScaledVector(flashlightAimRef.current, FLASHLIGHT_REACH);
      }
    }
    world.setAnchor(active.position.x, active.position.z);
    skyDomeRef.current?.setAnchor(active.position.x, active.position.z);
    // Traffic signals and neon flicker run off the render clock rather than accumulating
    // their own — see ThreeWorld.setAnimationTime.
    world.setAnimationTime(state.clock.elapsedTime);
    // Same clock, same contract: the flame is a pure function of it, so a rebuild or a
    // dropped frame leaves the fire exactly where it would have been.
    campRef.current?.update(state.clock.elapsedTime, nightFactorRef.current);

    if (control.cameraMode === 'freecam') {
      if (freecamSeedPendingRef.current) {
        freecamSeedPendingRef.current = false;
        freecamPositionRef.current.copy(state.camera.position);
        // Recovered from where the camera is actually looking rather than from the
        // rotation channels, which the chase/orbit rigs drive as a quaternion slerp and
        // leave in whatever Euler order they please.
        const facing = state.camera.getWorldDirection(new THREE.Vector3());
        freecamYawRef.current = Math.atan2(-facing.x, -facing.z);
        freecamPitchRef.current = Math.asin(THREE.MathUtils.clamp(facing.y, -1, 1));
      }
      // Integrated against the real frame time, not `dt`.
      //
      // `dt` is `min(rawDelta, 0.05)` — a cap that exists so a stalled frame cannot
      // teleport a physics body through geometry. Aiming a camera has no such failure
      // mode, and paying the cap here made the look rate silently frame-rate dependent:
      // below 20fps every frame is clamped to 50ms of turn however long it really took,
      // so on a slow machine holding a look key for six seconds turned the view a small
      // fraction of the radians per second FREECAM.lookSpeed promises. (docs/TODO.md
      // blamed the yaw/pitch refs being re-seeded every frame; they are not — the seed is
      // guarded by freecamSeedPendingRef and runs once per entry into the mode.)
      // Still bounded, because a multi-second stall should not spin the view: the bound
      // is just far enough out to cover any frame a player would sit through.
      const lookDt = Math.min(rawDelta, FREECAM.maxLookStep);
      freecamYawRef.current += input.lookX * FREECAM.lookSpeed * lookDt;
      freecamPitchRef.current = THREE.MathUtils.clamp(
        freecamPitchRef.current + input.lookY * FREECAM.lookSpeed * lookDt,
        -FREECAM.maxPitch,
        FREECAM.maxPitch,
      );
      // The camera looks down its own -Z, so this is that axis expressed from yaw/pitch.
      // It used to be built without the negations, which pointed it exactly backwards:
      // W flew away from whatever you had lined up in view, and S flew toward it.
      const cosPitch = Math.cos(freecamPitchRef.current);
      const flyForward = new THREE.Vector3(
        -Math.sin(freecamYawRef.current) * cosPitch,
        Math.sin(freecamPitchRef.current),
        -Math.cos(freecamYawRef.current) * cosPitch,
      );
      const flyRight = new THREE.Vector3(
        Math.cos(freecamYawRef.current),
        0,
        -Math.sin(freecamYawRef.current),
      );
      const move = new THREE.Vector3();
      move.addScaledVector(flyForward, input.forward);
      move.addScaledVector(flyRight, -input.turn);
      // Vertical is its own axis rather than part of the normalized heading, so rising
      // while flying forward does not slow the forward run to keep the total at one.
      const vertical = input.vertical;
      if (move.lengthSq() > 0) move.normalize();
      move.y += vertical;
      const speed = (input.boost ? FREECAM.boostSpeed : FREECAM.speed) * dt;
      freecamPositionRef.current.addScaledVector(move, speed);
      state.camera.position.copy(freecamPositionRef.current);
      state.camera.rotation.order = 'YXZ';
      state.camera.rotation.set(freecamPitchRef.current, freecamYawRef.current, 0);
    } else if (
      currentlyRiding
      && (currentPhase === 'driving' || currentPhase === 'braking')
      && control.cameraMode === 'cockpit'
    ) {
      // Seated in the back-left of the saloon. Bolted rigidly to the bus via its
      // matrix rather than reconstructed from the heading, so the ride's roll and
      // pitch carry into the view — and so the seat stays put if the model moves.
      state.camera.position.copy(BUS_SEAT_OFFSET).applyQuaternion(bus!.quaternion).add(bus!.position);
      state.camera.quaternion.copy(bus!.quaternion).multiply(BUS_SEAT_TURN);
    } else {
      // Where the camera *should* be is a pure question (see cameraRig); all this frame
      // owes is easing toward the answer, so a mode change or a sharp turn arrives as a
      // sweep rather than a cut.
      const introStart = openingCamStartMsRef.current;
      const introElapsed = introStart === null ? null : performance.now() - introStart;
      const introPlacement = introElapsed === null || introElapsed >= OPENING_CAM_INTRO_DURATION_MS
        ? null
        : resolveOpeningIntroPlacement(active.position, activeHeading, introElapsed);
      // Hand off from the scripted intro shot straight into the passenger seat, rather
      // than leaving the player on whatever mode the ride happened to board in.
      if (introPlacement === null && introStart !== null && !introCockpitAppliedRef.current) {
        introCockpitAppliedRef.current = true;
        setCameraRef.current('cockpit');
      }
      // The intro shot owns the camera outright while it runs, so as far as the modes are
      // concerned it has not been entered yet — which is what keeps orbit's clock (below)
      // from starting behind the scripted shot and jumping when it hands over.
      if (control.cameraMode !== lastCameraModeRef.current || introPlacement !== null) {
        lastCameraModeRef.current = introPlacement === null ? control.cameraMode : null;
        cameraModeEnteredMsRef.current = time;
      }
      const placement = introPlacement ?? resolveCameraPlacement(
        control.cameraMode,
        // The player's dials are a transform on whichever body rig is active, so one
        // "closer" means the same thing on foot as in the car — see applyCameraSettings.
        applyCameraSettings(rig, control.camera),
        active.position,
        activeHeading,
        time - cameraModeEnteredMsRef.current,
      );
      // The scripted intro is composed rather than followed, so it is left alone. Every
      // selectable mode gets both corrections: held off the ground it is flying over, and
      // pulled in along its own sightline so it is never left standing inside a building
      // or a tree.
      //
      // Top-down used to be excluded from the ground clamp on the reasoning that it is
      // far above everything by construction. That holds over open ground and fails
      // anywhere with a tree or a tall building: its boom is a fixed height above the
      // player, so it ends up inside the canopy. It is clamped and pulled in like the
      // rest now.
      if (introPlacement === null) {
        clampPlacementAboveGround(placement, groundHeightAt, CAMERA.groundClearance);
        pullPlacementClearOfObstruction(
          placement,
          cameraSightlineHit,
          CAMERA.groundClearance,
          CAMERA.minBoomDistance,
        );
      }
      const cameraBlend = 1 - Math.exp(-dt / cameraEaseTau(control.camera.responsiveness));
      applyCameraTransform(state.camera, placement.position, placement.lookAt, cameraBlend);
    }

    // Field of view, written only when it actually changed: updateProjectionMatrix is
    // cheap but not free, and this runs every frame for a value that changes only when a
    // slider moves. The camera's own `fov` is the record of what was last written — this
    // block is its only writer — so there is nothing to shadow it with.
    updateCameraFov(state.camera, control.camera.fov);

    // Render budget: sampled every frame (cheap), but the (possibly expensive)
    // buildings-visibility re-scan is throttled — except right after a budget change,
    // where it runs immediately so a slowdown response isn't delayed by up to
    // VISIBILITY_CHECK_INTERVAL_MS.
    const budgetChanged = renderBudgetRef.current.sample(dt);
    performanceCaptureRef.current.recordFrame(rawDelta * 1000, renderBudgetRef.current.getScale());
    if (budgetChanged) {
      const budgetScale = renderBudgetRef.current.getScale();
      world.setRenderBudgetScale(budgetScale);
      const quality = resolveEffectiveRenderQuality(control.renderOptions, budgetScale);
      // Buildings are now drawn to a shorter distance, so the fog has to come in to meet
      // the new cut — otherwise the budget's response to a slow machine is visible as
      // buildings winking out of clear air rather than as a hazier day.
      fogDensityTargetRef.current = fogDensityFor(quality.buildingDistance);
      if (control.renderOptions.dynamicResolution) {
        state.gl.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
        state.gl.setSize(state.gl.domElement.clientWidth, state.gl.domElement.clientHeight, false);
      }
    }
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density = THREE.MathUtils.lerp(
        fog.density,
        fogDensityTargetRef.current,
        1 - Math.exp(-dt / FOG_TAU),
      );
    }
    if (budgetChanged || time - lastVisibilityCheckRef.current > VISIBILITY_CHECK_INTERVAL_MS) {
      lastVisibilityCheckRef.current = time;
      world.updateVisibleBuildings(state.camera, { incremental: true });
    }

    control.speed = (currentlyRiding ? busSpeedRef.current : Math.abs(velocityRef.current)) * 3.6;
    control.position.x = active.position.x;
    control.position.z = active.position.z;

    // The dog companion (backlog item 16): stepped every frame against the player's
    // current position/speed/facing, whichever body that currently is (car, bus, or
    // on-foot pill) — a car bearing down on it counts as an approach just as much as a
    // running player does.
    if (dogModelRef.current) {
      const dog = dogModelRef.current;
      const dogState = dogStateRef.current;
      const dx = active.position.x - dogState.x;
      const dz = active.position.z - dogState.z;
      const distanceToPlayer = Math.hypot(dx, dz);
      // Within a 60-degree cone of the player's forward heading counts as "facing" — wide
      // enough to register a moving approach without needing pixel-perfect aim, narrow
      // enough to exclude someone merely passing by. World forward = (sin, cos) of heading,
      // matching bonfireCamp.ts's own convention. Uses the player-to-dog direction
      // (negated dx/dz, which point dog-to-player), since we need "is the player's
      // forward heading pointed at the dog," not the reverse.
      const facingDot = distanceToPlayer < 1e-3 ? 1 : (Math.sin(activeHeading) * -dx + Math.cos(activeHeading) * -dz) / distanceToPlayer;
      const dogInput: DogStepInput = {
        playerPosition: { x: active.position.x, z: active.position.z },
        playerSpeed: currentlyRiding ? busSpeedRef.current : Math.abs(velocityRef.current),
        playerFacingDog: facingDot >= 0.5,
      };
      // Occlusion: is this candidate retreat point visible to the player? A raycast
      // from the player's eye height to the candidate point's ground height, filtered
      // to CATEGORY_BUILDINGS — any hit closer than the full distance means a building
      // is in the way. physicsRef.current is null only in the instant before the mount
      // effect's own createPhysicsWorld() call runs, which is earlier in the same effect
      // than this per-frame callback can ever fire, but the guard costs nothing and
      // matches how every other physics-reading callback in this file treats the ref
      // as possibly-null.
      const isVisible = (point: { x: number; z: number }): boolean => {
        const physics = physicsRef.current;
        if (!physics) return true;
        const origin = new THREE.Vector3(active.position.x, active.position.y + 1.2, active.position.z);
        const target = new THREE.Vector3(point.x, dogState.y + 0.2, point.z);
        const toTarget = target.clone().sub(origin);
        const distance = toTarget.length();
        if (distance < 1e-3) return true;
        const direction = toTarget.normalize();
        const hit = physics.raycast(origin, direction, distance, null, CATEGORY_BUILDINGS);
        return !hit;
      };
      dogStateRef.current = stepDog(
        dogState,
        dogInput,
        dt,
        (point) => terrainHeightAtIndexed(point, terrainIndexRef.current),
        isVisible,
      );
      dog.group.position.set(dogStateRef.current.x, dogStateRef.current.y, dogStateRef.current.z);
      dog.group.rotation.y = dogStateRef.current.heading;
      control.dog = {
        x: dogStateRef.current.x, z: dogStateRef.current.z,
        behavior: dogStateRef.current.behavior, trust: dogStateRef.current.trust,
      };
      if (devMode && dogStateRef.current.behavior !== dogLoggedBehaviorRef.current) {
        dogLoggedBehaviorRef.current = dogStateRef.current.behavior;
        pushLog('info', 'dog', `${dogStateRef.current.behavior} (trust ${Math.round(dogStateRef.current.trust)})`);
      }
    }

    // Exponentially smoothed so the readout settles on what the frame rate actually is
    // instead of chasing the jitter of any single frame.
    if (dt > 0) {
      const instant = 1 / dt;
      fpsRef.current = fpsRef.current === 0
        ? instant
        : fpsRef.current + (instant - fpsRef.current) * Math.min(1, dt * 3);
    }

    if (Math.floor(time / 250) !== Math.floor((time - dt * 1000) / 250)) {
      const busModel = busModelRef.current;
      const currentData = currentDataRef.current;
      if (bus?.visible && busModel && currentData && time - lastBusDisplayAtRef.current >= 250) {
        lastBusDisplayAtRef.current = time;

        // The saloon sign reads the street the bus is on right now, and counts down the
        // distance still to run. Resolved every tick rather than once at departure
        // because both change continuously — and held at its last value between label
        // points (see lastBusStreetRef), since a long way carries one label per tile and
        // a sign that blanked out in between would spend most of the ride blank.
        const street = resolveCurrentStreet(bus.position, currentData.roads, currentData.labels);
        if (street) lastBusStreetRef.current = street;
        const profile = busProfileRef.current;
        setBusNextStop(
          busModel,
          lastBusStreetRef.current ?? STREET_FALLBACK,
          profile ? Math.max(0, profile.length - busTraveledRef.current) : null,
        );

        // The blind on the front of the bus faces the street, so it carries what a
        // waiting passenger needs: where this service terminates. Held the same way, and
        // for the same reason, as the street above — plus one of its own, that the road
        // the destination sits on may not have streamed in yet when the ride began.
        const path = busPathRef.current;
        const destination = path?.length ? path[path.length - 1] : null;
        const destinationName = destination
          && resolveCurrentStreet(destination, currentData.roads, currentData.labels);
        if (destinationName) lastBusDestinationRef.current = destinationName;
        setBusDisplayText(busModel, lastBusDestinationRef.current ?? DESTINATION_FALLBACK);
      }
      callbacksRef.current.onSpeed(control.speed);
      callbacksRef.current.onFps(fpsRef.current);
      if (currentData) {
        const area = resolveCurrentStreet(active.position, currentData.roads, currentData.labels)
          ?? START_LOCATION_NAME;
        if (area !== lastAreaRef.current) {
          lastAreaRef.current = area;
          callbacksRef.current.onArea(area);
        }
      }
      const nearby = rankNearbyPlaces(labelsRef.current, active.position.x, active.position.z, activeHeading);
      callbacksRef.current.onNearby(nearby);
      // The saloon's proximity strip runs off the same scan as the HUD, ranked the same
      // way, so the two never disagree about what is worth pointing out.
      if (bus?.visible && busModelRef.current) setBusProximity(busModelRef.current, nearby);
    }

    if (activeSourceRef.current === 'maplibre' && time - lastStreamCheckRef.current > STREAM_CHECK_INTERVAL_MS) {
      lastStreamCheckRef.current = time;

      // A route already known in full is a line, not a point ahead of the camera:
      // once the bus is actually running it, fetch the ribbon it is going to cross next,
      // a leg at a time, rather than the disc the free-roam prediction below uses when
      // there is no route to follow.
      const ridingTraveling = currentlyRiding
        && (currentPhase === 'driving' || currentPhase === 'braking')
        && !!busPath
        && !!busProfile;

      if (ridingTraveling) {
        const leg = nextRideCorridorLeg(
          busPath!,
          busTraveledRef.current,
          busCorridorFetchedAtRef.current,
          BUS_CORRIDOR_RESTREAM_METERS,
          BUS_CORRIDOR_LOOKAHEAD_METERS,
        );
        if (leg) {
          busCorridorFetchedAtRef.current = busTraveledRef.current;
          loadWorldRef.current('maplibre', localToLngLat(START_LOCATION, leg.to), true, {
            from: localToLngLat(START_LOCATION, leg.from),
            to: localToLngLat(START_LOCATION, leg.to),
            padMeters: BUS_CORRIDOR_PAD_METERS,
          });
        }
      } else {
        const aheadDistance = control.cameraMode === 'top-down' ? 120 : 420;
        const focusX = active.position.x + Math.sin(activeHeading) * aheadDistance;
        const focusZ = active.position.z + Math.cos(activeHeading) * aheadDistance;

        if (worldReadyRef.current && renderBudgetRef.current.getScale() >= 0.75) {
          const predicted = predictStreamCenter(
            { x: active.position.x, z: active.position.z },
            activeHeading,
            STREAM_RESTREAM_DISTANCE,
          );
          const predictedLngLat = localToLngLat(START_LOCATION, predicted);
          const predictedKey = worldCacheKey('maplibre', predictedLngLat);
          if (
            predictedKey !== lastPreloadKeyRef.current &&
            !worldDataCacheRef.current.has(predictedKey)
          ) {
            lastPreloadKeyRef.current = predictedKey;
            preloadControllerRef.current?.abort();
            const controller = new AbortController();
            preloadControllerRef.current = controller;
            const provider = createMapLibreProvider();
            void worldDataCacheRef.current.load(
              predictedKey,
              signal => provider.load(
                predictedLngLat,
                WORLD_DATA_RADIUS,
                signal,
                START_LOCATION,
              ).then(data => {
                if (data.roads.length + data.buildings.length <= 8) {
                  throw new Error('Preloaded world source returned insufficient map data');
                }
                return data;
              }),
              controller.signal,
            ).catch(() => {
              // Preload is opportunistic. Foreground loading owns user-visible errors.
            });
          }
        }

        // The anchor is where the player *was* when the world was last streamed, and the
        // centre is where that stream was centred — two different points, because the load
        // is deliberately biased forward. Keeping both is what lets the trigger tell
        // travelling apart from turning; see shouldRestream.
        if (shouldRestream(
          { x: active.position.x, z: active.position.z },
          { x: focusX, z: focusZ },
          { x: streamAnchorRef.current.x, z: streamAnchorRef.current.y },
          { x: streamedCenterRef.current.x, z: streamedCenterRef.current.y },
          { travelDistance: STREAM_RESTREAM_DISTANCE, coverageRadius: WORLD_DATA_RADIUS.terrain },
        )) {
          streamAnchorRef.current.set(active.position.x, active.position.z);
          streamedCenterRef.current.set(focusX, focusZ);
          loadWorldRef.current('maplibre', localToLngLat(START_LOCATION, { x: focusX, z: focusZ }), true);
        }
      }
    }
  });

  useEffect(() => {
    const updateKeyboard = () => {
      const keys = keysRef.current;
      const freecam = control.cameraMode === 'freecam';
      control.input.setSourceState('keyboard', {
        forward: keys.has('w') || (!freecam && keys.has('arrowup')) ? 1
          : keys.has('s') || (!freecam && keys.has('arrowdown')) ? -1 : 0,
        turn: keys.has('a') || (!freecam && keys.has('arrowleft')) ? 1
          : keys.has('d') || (!freecam && keys.has('arrowright')) ? -1 : 0,
        boost: keys.has('shift'),
        brake: false,
        lookX: keys.has('arrowleft') ? 1 : keys.has('arrowright') ? -1 : 0,
        lookY: keys.has('arrowup') ? 1 : keys.has('arrowdown') ? -1 : 0,
        // E is "get in / get out" everywhere else, so it no longer doubles as fly-up —
        // one key meaning two things depending on the camera was the least predictable
        // part of these controls. Space rises, Q drops.
        vertical: keys.has(' ') ? 1 : keys.has('q') ? -1 : 0,
        // On foot/blob, Space is reused as jump (freecam claims the same key for rising,
        // but the two modes are never active at once) and C is crouch, held.
        jump: keys.has(' '),
        crouch: keys.has('c'),
      });
    };
    const keyDown = (event: KeyboardEvent) => {
      keysRef.current.add(event.key.toLowerCase());
      updateKeyboard();
    };
    const keyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(event.key.toLowerCase());
      updateKeyboard();
    };
    const releaseKeyboard = () => {
      keysRef.current.clear();
      control.input.releaseSource('keyboard');
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', releaseKeyboard);
    document.addEventListener('visibilitychange', releaseKeyboard);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', releaseKeyboard);
      document.removeEventListener('visibilitychange', releaseKeyboard);
    };
  }, [control]);

  return (
    <>
      <hemisphereLight ref={ambientRef} args={[0xd9f0ff, 0x49513e, 2.4]} />
      <directionalLight
        ref={sunRef}
        castShadow
        color={0xfff0cf}
        intensity={3.2}
        // A ±280 unit frustum spread only 2048 texels that thin, coarse enough to look
        // jagged on anything nearby (like the car). Tightening it to what's actually
        // needed around the car (it recenters every frame — see useFrame's
        // sun.position line) roughly quadruples the effective texel density.
        shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-130}
        shadow-camera-right={130}
        shadow-camera-top={130}
        shadow-camera-bottom={-130}
        shadow-camera-near={SHADOW_CAMERA_NEAR}
        shadow-camera-far={SHADOW_CAMERA_FAR}
        shadow-bias={-0.0003}
        shadow-normalBias={0.04}
        // Radius of the PCF sampling disk in shadow-map texels — see SHADOW_QUALITY,
        // which overwrites this per tier the moment render options are applied.
        shadow-radius={4}
      />
    </>
  );
}

/**
 * PCFShadowMap. Not PCFSoftShadowMap, which this Three.js version deprecated and
 * silently maps onto PCFShadowMap anyway (logging a warning on the first shadow
 * render), and no longer VSM.
 *
 * VSM was chosen when PCFShadowMap still meant a fixed 3x3 kernel with hard edges, but
 * it is the direct cause of the striped, wavy shadows: its softness comes from a
 * separable *box* blur over the depth moments, so every shadow's penumbra is quantised
 * into bands of constant width, and Chebyshev's variance test turns any receiver at a
 * shallow angle to the sun (roads, ground, long flat roofs — most of this scene) into
 * a ripple of alternating light and dark. Those two together are exactly the "stripy
 * and wavy where it should just blend" look, and no amount of bias tuning removes them
 * because they are inherent to filtering depth moments rather than depth comparisons.
 *
 * PCFShadowMap in this version is a 5-tap Vogel disk scaled by `shadow.radius` texels,
 * with the sampling pattern rotated per pixel by interleaved-gradient noise on top of
 * hardware 2x2 comparison filtering. It is genuinely soft, and because the kernel is
 * dithered rather than fixed, its error shows up as fine noise that the neighbouring
 * pixels average out instead of as coherent bands.
 *
 * Passed to <Canvas shadows={...}> rather than set imperatively (e.g. in onCreated) —
 * react-three-fiber's own Canvas wrapper re-applies its `shadows` prop (defaulting to
 * `{enabled: false, type: PCFSoftShadowMap}` when the prop is omitted) via an internal
 * effect that runs on *every* Canvas re-render, with no dependency array. An
 * imperative one-time mutation would keep getting silently overwritten back to that
 * default the next time anything causes SvartaksiScene to re-render — this constant,
 * passed through reactive `shadows` state (see shadowsEnabled below), is instead the
 * single source of truth R3F itself keeps reapplying, so every reapplication is a
 * harmless no-op instead of a regression.
 */
const SHADOW_CONFIG = { type: THREE.PCFShadowMap };

function SvartaksiScene({
  control,
  callbacks,
  onReady,
}: {
  control: RuntimeControl;
  callbacks: Pick<RuntimeOptions, 'onStatus' | 'onSpeed' | 'onFps' | 'onArea' | 'onNearby' | 'onMode' | 'onCameraMode' | 'onHint' | 'onSpeech' | 'onInspection'>;
  onReady: (api: SceneApi) => void;
}) {
  const [shadowsEnabled, setShadowsEnabled] = useState(true);

  return (
    <>
      <Canvas
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          // near=0.1 vs far=2500 leaves a standard depth buffer too coarse at
          // distance, fighting between ground/park/road layers; log depth buffer
          // fixes precision without shrinking the view range.
          logarithmicDepthBuffer: true,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        dpr={[1, 2]}
        camera={{ fov: DEFAULT_CAMERA_SETTINGS.fov, near: 0.1, far: 2500 }}
        shadows={shadowsEnabled ? SHADOW_CONFIG : false}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
          setWorldTextureAnisotropy(gl.capabilities.getMaxAnisotropy());
          // "Baking": the shadow pass only re-renders on demand (needsUpdate, set from
          // useFrame's recentre check in WorldScene) rather than every frame. R3F's own
          // effect for the `shadows` prop only ever touches shadowMap.enabled/type (see
          // the SHADOW_CONFIG comment below), never autoUpdate, so this survives every
          // later re-render of <Canvas> untouched — a one-time toggle, not a per-frame
          // fight with R3F. needsUpdate starts true so the first frame still renders.
          gl.shadowMap.autoUpdate = false;
          gl.shadowMap.needsUpdate = true;
        }}
      >
        <WorldScene
          control={control}
          callbacks={callbacks}
          setShadowsEnabled={setShadowsEnabled}
          onReady={onReady}
        />
      </Canvas>
    </>
  );
}

export function createSvartaksiRuntime({ host, onStatus, onSpeed, onFps, onArea, onNearby, onMode, onCameraMode, onHint, onSpeech, onInspection }: RuntimeOptions): SvartaksiRuntime {
  const control: RuntimeControl = {
    source: 'maplibre',
    renderOptions: { ...DEFAULT_RENDER_OPTIONS },
    cameraMode: 'chase',
    camera: { ...DEFAULT_CAMERA_SETTINGS },
    timeOfDay: DEFAULT_TIME_OF_DAY,
    speed: 0,
    // The world origin until the first frame writes a real one, which puts an early
    // caller at START_LOCATION rather than nowhere — see getPlayerLngLat.
    position: { x: 0, z: 0 },
    mode: 'car',
    dog: null,
    inspectorEnabled: false,
    flashlight: false,
    inspectorPointer: null,
    inspectorPending: false,
    blobPointer: null,
    blobControlScheme: 'direct',
    input: createPlayerInputController(),
    inputPaused: false,
  };
  const callbacks = { onStatus, onSpeed, onFps, onArea, onNearby, onMode, onCameraMode, onHint, onSpeech, onInspection };
  const performanceCaptureStart = createDeferredPerformanceCaptureStart();
  let sceneApi: SceneApi | null = null;
  let reactRoot: Root | null = null;

  // Both creation and disposal are deferred by one microtask, not just disposal —
  // under StrictMode's dev-only double-invoke (mount → cleanup → mount, all
  // synchronous within one flush), a synchronous createRoot(host) here plus a
  // deferred-only unmount() would let the *second* createSvartaksiRuntime call's
  // createRoot(host) run before the first instance's deferred unmount had executed —
  // two roots on the same container, which React rejects ("You are calling
  // ReactDOMClient.createRoot() on a container that has already been passed to
  // createRoot() before"). Deferring both by a microtask preserves call order (JS
  // microtasks are FIFO), so this instance's create always finishes — and, if
  // disposed, its unmount always completes — before a subsequent instance's create
  // runs on the same host.
  queueMicrotask(() => {
    reactRoot = createRoot(host);
    reactRoot.render(
      <SvartaksiScene
        control={control}
        callbacks={callbacks}
        onReady={(api) => {
          sceneApi = api;
          // Replay whatever's already been set — covers calls made before this fired.
          api.applyRenderOptions(control.renderOptions);
          api.applySource(control.source);
          api.applyTimeOfDay(control.timeOfDay);
          performanceCaptureStart.replay(api.startPerformanceCapture);
        }}
      />,
    );
  });

  return {
    setSource(source) {
      control.source = source;
      sceneApi?.applySource(source);
    },
    setRenderOptions(options) {
      control.renderOptions = options;
      sceneApi?.applyRenderOptions(options);
    },
    setCameraMode(mode) {
      // Switchable during a ride too: 'cockpit' is the passenger seat while the bus
      // is running, and every other mode frames the bus instead of the car.
      control.cameraMode = mode;
    },
    setCameraSettings(settings) {
      control.camera = settings;
    },
    setTimeOfDay(hours) {
      control.timeOfDay = hours;
      sceneApi?.applyTimeOfDay(hours);
    },
    startPerformanceCapture() {
      performanceCaptureStart.request(() => sceneApi?.startPerformanceCapture());
    },
    snapshotPerformanceCapture() {
      return sceneApi?.snapshotPerformanceCapture() ?? null;
    },
    stopPerformanceCapture() {
      performanceCaptureStart.clear();
      return sceneApi?.stopPerformanceCapture() ?? null;
    },
    getSpeed: () => control.speed,
    getPlayerLngLat: () => localToLngLat(START_LOCATION, control.position),
    getDogSnapshot: () => control.dog,
    teleportTo(lng, lat) {
      sceneApi?.applyTeleport(lng, lat);
    },
    spawnRandomPlace() {
      return sceneApi?.applySpawnRandomPlace() ?? false;
    },
    startBusRide(path, signalStops) {
      // The optional call is the sceneApi-is-still-null case, which is a real
      // possibility rather than defensive coding: the scene mounts a microtask after
      // this runtime is handed to App.tsx, so an early call has nothing to start on.
      sceneApi?.applyStartBusRide(path, signalStops);
    },
    stopBusRide() {
      sceneApi?.applyStopBusRide();
    },
    toggleVehicle() {
      sceneApi?.applyToggleVehicle();
    },
    spawnCar() {
      return sceneApi?.applySpawnCar() ?? false;
    },
    spawnModel(model) {
      // Rejects rather than resolving to a sentinel when the scene is not up yet: a
      // caller awaiting a spawn needs to hear that it did not happen.
      if (!sceneApi) return Promise.reject(new Error('scene not ready'));
      return sceneApi.applySpawnModel(model);
    },
    clearSpawnedModels() {
      return sceneApi?.applyClearSpawnedModels() ?? 0;
    },
    tipLastSpawnedModel() {
      return sceneApi?.applyTipLastSpawnedModel() ?? null;
    },
    toggleBlobForm() {
      sceneApi?.applyToggleBlobForm();
    },
    setBlobPointer(clientX, clientY) {
      control.blobPointer = { x: clientX, y: clientY };
    },
    releaseBlobPointer() {
      control.blobPointer = null;
    },
    setBlobControlScheme(scheme) {
      control.blobControlScheme = scheme;
    },
    setFlashlight(on) {
      control.flashlight = on;
    },
    setInspectorEnabled(enabled) {
      control.inspectorEnabled = enabled;
      control.inspectorPending = false;
      if (!enabled) {
        control.inspectorPointer = null;
        onInspection(null);
      }
    },
    setInspectorPointer(clientX, clientY) {
      control.inspectorPointer = { x: clientX, y: clientY };
      control.inspectorPending = true;
    },
    retryWorldLoad() {
      sceneApi?.retryWorldLoad();
    },
    setInputSourceState(source, state) {
      control.input.setSourceState(source, state);
    },
    releaseInputSource(source) {
      control.input.releaseSource(source);
    },
    setInputPaused(paused) {
      control.inputPaused = paused;
      if (paused) {
        control.input.releaseSource('keyboard');
        control.input.releaseSource('touch');
      }
    },
    dispose() {
      // Deferred rather than synchronous — see the comment above createRoot(). This
      // also fixes "Attempted to synchronously unmount a root while React was
      // already rendering" (calling unmount() synchronously here fires while the
      // *outer* root, App.tsx's, is still mid-commit under StrictMode).
      queueMicrotask(() => reactRoot?.unmount());
    },
  };
}
