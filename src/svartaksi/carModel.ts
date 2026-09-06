/**
 * The player's car, and the lights on it that actually do something.
 *
 * Split out of svartaksiRuntime for the same reason busModel.ts is: the geometry is inert
 * setup, and the small amount of per-frame state it has (which lamps are lit, how
 * brightly) reads far better as a couple of named functions than as more lines inside an
 * 1800-line frame loop.
 *
 * Lighting model, in ascending order of cost:
 *
 * - **Tail lights** are emissive only. They are visible because the lens glows, not
 *   because they illuminate anything, which is also true of the real thing.
 * - **Brake lights** are the same lenses driven much harder. One material, three
 *   states — off, tail, braking — so there is nothing to keep in sync.
 * - **Headlights** are two real SpotLights, because a headlight that does not put a
 *   cone of light on the road ahead is not a working headlight. They are the only
 *   dynamic lights this car adds, and Three's forward renderer charges every
 *   MeshStandardMaterial fragment in the scene for each one, so they exist as exactly
 *   two and are switched off outright (intensity 0) whenever it is not dark.
 */
import * as THREE from 'three';
import { SAAB_DIMENSIONS, SAAB_HALF_WHEELBASE, type SaabShell } from './saabModel';

/**
 * Every dimension below is the Saab's, measured from `saab90.glb` (see SAAB_DIMENSIONS).
 * The procedural shape this module builds is a stand-in for the seconds before that asset
 * finishes decoding, so it is built to the same numbers: when the shell is swapped in,
 * nothing about the car's size, wheel positions or lamp positions changes, and the
 * physics car — which is built to these constants and cannot be rebuilt mid-drive —
 * remains the shape of the car you can see.
 */

/** Wheel radius the physics vehicle's struts are sized against, and the radius the
 * tyre below is actually built at. */
export const CAR_WHEEL_RADIUS = SAAB_DIMENSIONS.wheelRadius;
/** Half-track and half-wheelbase: where the four struts are bolted to the body. Shared
 * with the physics vehicle so the wheels it simulates are the wheels you can see. */
export const CAR_HALF_TRACK = SAAB_DIMENSIONS.halfTrack;
export const CAR_HALF_WHEELBASE = SAAB_HALF_WHEELBASE;

export interface CarModel {
  group: THREE.Group;
  /**
   * The four wheels: front-left, front-right, rear-left, rear-right. Each is a group
   * whose transform the suspension writes every frame — its local y is where the strut
   * has travelled to, its rotation the steering and the roll. Ordered to match the
   * physics vehicle's wheel list exactly, so index i is the same wheel in both.
   */
  wheels: [THREE.Group, THREE.Group, THREE.Group, THREE.Group];
  headlights: [THREE.SpotLight, THREE.SpotLight];
  /** Front lens glow, so the car reads as lit from in front of it too. */
  headlightLensMaterial: THREE.MeshStandardMaterial;
  /** Rear lens glow. Carries both the tail and the brake state — see setCarLights. */
  tailLensMaterial: THREE.MeshStandardMaterial;
  /** White reversing lamps, beside the tail lights. */
  reverseLensMaterial: THREE.MeshStandardMaterial;
}

/** Peak headlight intensity at full night. */
const HEADLIGHT_INTENSITY = 26;
/** Headlights come on at dusk rather than tracking the night factor from zero — a car
 * with its lights faintly on all afternoon looks broken, not subtle. */
const HEADLIGHT_THRESHOLD = 0.3;
const HEADLIGHT_LENS_EMISSIVE = 1.5;

/** Tail lamps: on with the headlights, dim. Brake lamps: the same lenses at roughly
 * four times that, which is about the ratio a real tail/brake filament pair runs at and
 * is what makes a brake application readable from behind at night. */
const TAIL_EMISSIVE = 0.5;
const BRAKE_EMISSIVE = 2.2;
const REVERSE_EMISSIVE = 1.6;

/** Name of the group holding the stand-in body, so the swap can find it. */
const SHELL_GROUP_NAME = 'car:shell';
/** Name of the stand-in tyre inside each wheel hub, for the same reason. */
const TYRE_NAME = 'car:tyre';

export function createCarModel(): CarModel {
  const group = new THREE.Group();
  group.name = 'car';

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf04f36, roughness: 0.42, metalness: 0.18 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x13191d, roughness: 0.7 });

  // Kept in its own group so `applySaabShell` can lift the whole stand-in out in one
  // call once the real body has decoded, without having to know which children it added.
  const shell = new THREE.Group();
  shell.name = SHELL_GROUP_NAME;
  group.add(shell);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(SAAB_DIMENSIONS.width, 0.62, SAAB_DIMENSIONS.length),
    bodyMaterial,
  );
  body.position.y = 0.72;
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(SAAB_DIMENSIONS.width - 0.34, 0.6, 2.1),
    new THREE.MeshStandardMaterial({ color: 0x8ab6c2, roughness: 0.25, metalness: 0.25 }),
  );
  cabin.position.set(0, 1.25, -0.2);
  cabin.castShadow = true;
  cabin.receiveShadow = true;
  shell.add(cabin);

  // The tyre is baked lying on its side so the wheel group's own rotation is free to
  // carry steering (y) and roll (x) without a fixed tilt composing into them.
  const tyreGeometry = new THREE.CylinderGeometry(CAR_WHEEL_RADIUS, CAR_WHEEL_RADIUS, 0.32, 18)
    .rotateZ(Math.PI / 2);
  const wheels = ([
    [-CAR_HALF_TRACK, SAAB_DIMENSIONS.frontAxleZ],
    [CAR_HALF_TRACK, SAAB_DIMENSIONS.frontAxleZ],
    [-CAR_HALF_TRACK, SAAB_DIMENSIONS.rearAxleZ],
    [CAR_HALF_TRACK, SAAB_DIMENSIONS.rearAxleZ],
  ] as const).map(([x, z]) => {
    const hub = new THREE.Group();
    hub.name = `car:wheel:${x > 0 ? 'left' : 'right'}:${z > 0 ? 'front' : 'rear'}`;
    hub.position.set(x, CAR_WHEEL_RADIUS, z);
    const tyre = new THREE.Mesh(tyreGeometry, dark);
    tyre.name = TYRE_NAME;
    tyre.castShadow = true;
    tyre.receiveShadow = true;
    hub.add(tyre);
    group.add(hub);
    return hub;
  }) as [THREE.Group, THREE.Group, THREE.Group, THREE.Group];

  // Lenses sit a hair proud of the body's own end faces so they never z-fight with the
  // panel they are mounted on.
  const frontZ = SAAB_DIMENSIONS.length / 2 + 0.02;
  const rearZ = -frontZ;

  const headlightLensMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff0cf,
    emissive: 0xffd79a,
    emissiveIntensity: 0,
    toneMapped: false,
  });
  const lensGeometry = new THREE.BoxGeometry(0.42, 0.16, 0.06);
  for (const x of [-0.7, 0.7]) {
    const lens = new THREE.Mesh(lensGeometry, headlightLensMaterial);
    lens.position.set(x, 0.92, frontZ);
    group.add(lens);
  }

  const tailLensMaterial = new THREE.MeshStandardMaterial({
    color: 0x7a1512,
    emissive: 0xff2a18,
    emissiveIntensity: 0,
    toneMapped: false,
  });
  for (const x of [-0.72, 0.72]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.06), tailLensMaterial);
    lens.position.set(x, 0.95, rearZ);
    group.add(lens);
  }

  const reverseLensMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8dee2,
    emissive: 0xf2f6ff,
    emissiveIntensity: 0,
    toneMapped: false,
  });
  for (const x of [-0.34, 0.34]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.06), reverseLensMaterial);
    lens.position.set(x, 0.78, rearZ);
    group.add(lens);
  }

  const headlights = [-0.7, 0.7].map((x, index) => {
    const light = new THREE.SpotLight(0xffe6bd, 0, 55, Math.PI / 8, 0.5, 1.5);
    light.name = index === 0 ? 'car:headlight-left' : 'car:headlight-right';
    light.position.set(x, 0.92, frontZ);
    // Shadow-casting headlights would mean two more shadow maps rendered every frame,
    // on top of the sun's. The cone on the road is what sells them; the geometry it
    // passes is already shadowed by the sun.
    light.castShadow = false;
    // Aimed slightly down and well ahead, so the pool of light lands on the road rather
    // than on the horizon.
    const target = new THREE.Object3D();
    target.position.set(x * 1.6, -0.6, frontZ + 22);
    group.add(light, target);
    light.target = target;
    return light;
  }) as [THREE.SpotLight, THREE.SpotLight];

  return { group, wheels, headlights, headlightLensMaterial, tailLensMaterial, reverseLensMaterial };
}

/**
 * Whether the brake lamps should be lit, given the driver's inputs and how fast the car
 * is going.
 *
 * Two things light them, matching the two ways this car actually sheds speed: the brake
 * input, and selecting reverse while still rolling forwards — which in these controls is
 * how you stop hard without the brake key, and which a following driver has exactly as
 * much right to see. Coasting does not, on either count: lift-off is not braking, and a
 * car whose brake lights came on every time you released the throttle would be the
 * annoying one in traffic.
 */
export function isCarBraking(brake: boolean, forward: number, velocity: number): boolean {
  if (brake && Math.abs(velocity) > 0.1) return true;
  return forward < 0 && velocity > 0.5;
}

export interface CarLightState {
  /** 0 in daylight, 1 at full night — the same value the sky and the bus run on. */
  nightFactor: number;
  braking: boolean;
  reversing: boolean;
}

/**
 * Drives every lamp on the car from one call per frame.
 *
 * Brake lights are deliberately independent of `nightFactor`: they are as much a signal
 * at noon as at midnight, and a brake light that only worked after dark would be the
 * one obviously wrong thing about the car.
 */
export function setCarLights(model: CarModel, state: CarLightState): void {
  const night = Math.max(0, Math.min(1, state.nightFactor));
  const headlightsOn = night >= HEADLIGHT_THRESHOLD;

  const intensity = headlightsOn ? HEADLIGHT_INTENSITY * night : 0;
  for (const light of model.headlights) light.intensity = intensity;
  model.headlightLensMaterial.emissiveIntensity = headlightsOn ? HEADLIGHT_LENS_EMISSIVE * night : 0;

  model.tailLensMaterial.emissiveIntensity = state.braking
    ? BRAKE_EMISSIVE
    : headlightsOn ? TAIL_EMISSIVE * night : 0;
  model.reverseLensMaterial.emissiveIntensity = state.reversing ? REVERSE_EMISSIVE : 0;
}

/**
 * Swaps the decoded Saab in for the stand-in, in place.
 *
 * In place matters: the physics vehicle holds references to the four wheel hubs and the
 * runtime holds one to `group`, both handed out when the car was created, and the asset
 * finishes decoding some hundreds of milliseconds into a session that has already started
 * driving. So the hubs are kept and re-dressed rather than rebuilt — only the geometry
 * hanging off them changes, and nothing outside this function can tell the swap happened
 * beyond the car suddenly looking like a car.
 *
 * The hubs also move to the wheels' measured half-track. The struts stay where physics
 * put them (they cannot move on a live vehicle), so this is the one place the visible car
 * and the simulated car are allowed to disagree — by whatever the measured track differs
 * from `SAAB_DIMENSIONS.halfTrack`, which is millimetres, and visibly better than wheels
 * that hover outboard of their arches.
 */
export function applySaabShell(model: CarModel, shell: SaabShell): void {
  const placeholder = model.group.getObjectByName(SHELL_GROUP_NAME);
  if (placeholder) {
    placeholder.removeFromParent();
    disposeTree(placeholder);
  }

  shell.body.name = SHELL_GROUP_NAME;
  model.group.add(shell.body);

  model.wheels.forEach((hub, index) => {
    const part = shell.wheels[index];
    const tyre = hub.getObjectByName(TYRE_NAME);
    if (tyre) {
      tyre.removeFromParent();
      disposeTree(tyre);
    }
    const wheel = new THREE.Mesh(part.geometry, shell.body.children[0] instanceof THREE.Mesh
      ? (shell.body.children[0] as THREE.Mesh).material
      : new THREE.MeshStandardMaterial({ color: 0x14181c }));
    wheel.name = TYRE_NAME;
    wheel.castShadow = true;
    wheel.receiveShadow = true;
    hub.add(wheel);
    hub.position.x = Math.sign(hub.position.x) * shell.halfTrack;
  });
}

/** Frees the GPU buffers of a subtree being thrown away. Geometry and materials are not
 * garbage-collected with their meshes; without this the stand-in leaks a buffer per car. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
}
