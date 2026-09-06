import * as THREE from 'three';

import { applyLogDepthBias, DEPTH_BIAS } from '../world/depthBias';
import { BUS_DIMENSIONS, computeAckermannAngles } from './busGeometry';
import { updateBusShellWheels, type BusShellWheel, type BusShellWheelState } from './busShellWheels';

/**
 * Chassis constants below are re-exports of BUS_DIMENSIONS rather than independent
 * numbers: BUS_DIMENSIONS (busGeometry.ts) is the single approved measurement sheet, and
 * everything that lays the shell out, drives the runtime placement, or profiles route
 * speed reads its wheelbase, track, and axle positions from there. See backlog item 2.
 */
export const BUS_FLOOR_Y = BUS_DIMENSIONS.floorHeight;
export const BUS_INTERIOR_HALF_WIDTH = 1.2;
export const BUS_INTERIOR_HALF_LENGTH = 5.3;
export const BUS_DOOR_SIDE_X = -1.26;
export const BUS_DOOR_BACK_Z = BUS_DIMENSIONS.doorBackZ;
export const BUS_DOOR_FRONT_Z = BUS_DIMENSIONS.doorFrontZ;
/**
 * How far a door leaf turns on its axle when open. A quarter turn puts the leaf square
 * across the doorway — half of it outside the body, half inside — which is what a pivot
 * door actually does. Kept as a signed angle because the front leaf turns this way and
 * the rear leaf the other; see setBusDoorOpen.
 */
export const BUS_DOOR_OPEN_ANGLE = -Math.PI / 2;

/** How far either side of the centreline the free-walking rider may stray while the bus
 * is under way — narrowed from the old "whole open floor" (BUS_INTERIOR_HALF_WIDTH) down
 * to the actual aisle, per the "make the movable area in the bus much narrower" ask.
 * BUS_SEAT_COLLIDERS covers the rest of the width so a rider pushed toward a row by a
 * sharp corner is still kept out of the seats rather than sliding into them. */
export const BUS_AISLE_HALF_WIDTH = 0.55;

/** Confines a bus-local point to the aisle strip running the length of the saloon. Seat
 * collision (BUS_SEAT_COLLIDERS/resolveAgainstBusSeats) is applied separately by the
 * caller, since it also has to run against the door-side walk path this function is not
 * used for. */
export function clampToBusFloor(localX: number, localZ: number): { x: number; z: number } {
  return {
    x: THREE.MathUtils.clamp(localX, -BUS_AISLE_HALF_WIDTH, BUS_AISLE_HALF_WIDTH),
    z: THREE.MathUtils.clamp(localZ, -BUS_INTERIOR_HALF_LENGTH, BUS_INTERIOR_HALF_LENGTH),
  };
}

/** One box per seat pair the saloon layout (below, "--- Saloon ---") actually places —
 * cushion plus backrest, generous enough to cover both without needing to track the two
 * meshes' exact half-extents separately. Built once at module load since the layout is
 * fixed geometry, not per-instance data. */
export interface BusSeatBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const SEAT_HALF_X = 0.3;
const SEAT_HALF_Z = 0.34;
const SEAT_TOP_Y = 1.8;

export const BUS_SEAT_COLLIDERS: BusSeatBox[] = (() => {
  const boxes: BusSeatBox[] = [];
  for (let row = 0; row < 7; row += 1) {
    const z = -4.5 + row * 1.05;
    for (const x of [-0.88, 0.88]) {
      if (x < 0 && z > BUS_DOOR_BACK_Z - 0.35 && z < BUS_DOOR_FRONT_Z + 0.35) continue;
      boxes.push({ minX: x - SEAT_HALF_X, maxX: x + SEAT_HALF_X, minZ: z - SEAT_HALF_Z, maxZ: z + SEAT_HALF_Z });
    }
  }
  return boxes;
})();

/** Seat colliders reach this high off the floor (a standing rider's feet, not a seated
 * one) — used by the runtime to know whether a seat should also block outright rather
 * than just be walked around. Exported for callers that want to reason about seat
 * height rather than only ground-plane overlap. */
export const BUS_SEAT_HEIGHT = SEAT_TOP_Y;

/**
 * Pushes a bus-local point (treated as a circle of `radius`) out of every seat box it
 * overlaps — the same closest-point-on-box clamp collision.ts's collideSphereBox uses,
 * done directly in local 2D since the saloon layout is fixed geometry local to the bus
 * rather than a set of bodies registered with the physics world.
 */
export function resolveAgainstBusSeats(localX: number, localZ: number, radius: number): { x: number; z: number } {
  let x = localX;
  let z = localZ;
  for (const box of BUS_SEAT_COLLIDERS) {
    const closestX = THREE.MathUtils.clamp(x, box.minX, box.maxX);
    const closestZ = THREE.MathUtils.clamp(z, box.minZ, box.maxZ);
    const dx = x - closestX;
    const dz = z - closestZ;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;
    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      const push = (radius - dist) / dist;
      x += dx * push;
      z += dz * push;
    } else {
      // Degenerate: centre sits inside the box (closest-point clamp lands back on
      // itself) — push out along whichever axis has the smaller overlap, same
      // tie-break collideSphereBox's "inside" branch uses, and clear the box edge by a
      // full radius rather than stopping flush on it.
      const overlapX = Math.min(x - box.minX, box.maxX - x);
      const overlapZ = Math.min(z - box.minZ, box.maxZ - z);
      if (overlapX < overlapZ) x += (x < (box.minX + box.maxX) / 2 ? -1 : 1) * (overlapX + radius);
      else z += (z < (box.minZ + box.maxZ) / 2 ? -1 : 1) * (overlapZ + radius);
    }
  }
  return { x, z };
}

/**
 * Places the free-walking rider inside the moving bus: rotates their bus-local offset
 * (from riderLocalOffsetRef) by the bus's own heading and adds it to the bus's world
 * position. This must run every tick the bus is occupied — including while it is
 * actually driving or braking — or the pill silently stops tracking the bus body during
 * the one phase riding matters most. See the `if (riding)` (not `else if`) comment at
 * its call site in svartaksiRuntime.tsx.
 */
export function computeRiderWorldPosition(
  busPosition: { x: number; z: number },
  busRotationY: number,
  riderLocalOffset: { x: number; z: number },
): { x: number; z: number } {
  const cos = Math.cos(busRotationY);
  const sin = Math.sin(busRotationY);
  const { x: localX, z: localZ } = riderLocalOffset;
  return {
    x: busPosition.x + localX * cos + localZ * sin,
    z: busPosition.z - localX * sin + localZ * cos,
  };
}

/**
 * Chassis geometry. The bus steers on its front axle only, so these two numbers are not
 * decoration: the runtime places the front axle on the routed path, drags the rear axle
 * a wheelbase behind it, and takes the body's heading from the line between them. That is
 * what makes the back end cut inside a corner the way a long vehicle does.
 */
export const BUS_FRONT_AXLE_Z = BUS_DIMENSIONS.frontAxleZ;
export const BUS_REAR_AXLE_Z = BUS_DIMENSIONS.rearAxleZ;
export const BUS_WHEELBASE = BUS_DIMENSIONS.wheelbase;
/** Lock-to-lock limit on the (virtual, bicycle-model) front wheel angle, in radians.
 * Derived from BUS_WHEELBASE and BUS_DIMENSIONS.minTurnRadius (computeMaxSteerAngle in
 * busGeometry.ts) rather than tuned by eye — see the design note there. */
export const BUS_MAX_STEER = BUS_DIMENSIONS.maxSteerAngle;
/** Rear-axle turn radius BUS_MAX_STEER implies. Route speed profiling (busRouting.ts)
 * flags any corner geometrically tighter than this rather than silently clipping it. */
export const BUS_MIN_TURN_RADIUS = BUS_DIMENSIONS.minTurnRadius;
/** Turns of the steering wheel per radian of road wheel. An old bus has a slow box and a
 * big wheel, so the driver's hands move a long way for a small change of course. */
const STEERING_RATIO = 5.5;

/** Rolling radius of every tyre — all six run the same size. Lets a caller turn distance
 * travelled into a spin angle without reaching into the geometry. */
export const BUS_WHEEL_RADIUS = BUS_DIMENSIONS.wheelRadius;
/** Height of every axle above the road at rest. The suspension moves each wheel about
 * this, so it is shared with setBusWheelTravel below. */
export const BUS_AXLE_Y = BUS_DIMENSIONS.axleHeight;
/** Half-track of the outer wheels (and, on the front axle, the only wheels), and of the
 * rear inner dual pair. */
export const BUS_HALF_TRACK = BUS_DIMENSIONS.track / 2;
export const BUS_INNER_HALF_TRACK = BUS_DIMENSIONS.innerTrack / 2;

const BUS_DOOR_HEIGHT = 2.04;
const DISPLAY_FALLBACK = 'NEXT STOP';
/** Shown on the proximity strip when nothing named is close enough to report. */
const PROXIMITY_FALLBACK = '· · ·';

/**
 * Outer skin of the shell. Every panel is placed by explicit bounds against these, and
 * neighbours are made to *interpenetrate* by a few millimetres rather than to meet face
 * to face: two coplanar faces at the same depth are exactly what the depth buffer cannot
 * resolve, and the shimmering seams down the sills and around the windows were all of
 * that kind.
 */
const HALF_WIDTH = 1.3;
const HALF_LENGTH = 5.5;
const WALL_INNER = 1.22;
const ROOF_Y = 2.94;
const WAIST_Y = 1.76;
const CANT_RAIL_Y = 2.64;

export interface BusModel {
  group: THREE.Group;
  /** Container for the two door leaves. Its own transform is never animated — the leaves
   * turn on their own axles inside it (see setBusDoorOpen). */
  door: THREE.Group;
  /** Front axle, one group per side, turned by setBusSteer. */
  frontWheels: [THREE.Group, THREE.Group];
  /** Every wheel's own axle, spun by setBusWheelRoll — front ones sit inside frontWheels'
   * steer groups, so they roll about their own axis even at full lock. */
  wheelRoll: THREE.Group[];
  /** The driver's wheel, turned STEERING_RATIO times as far as the road wheels. */
  steeringWheel: THREE.Object3D;
  headlights: [THREE.SpotLight, THREE.SpotLight];
  /** Saloon fill, so the inside of the bus is visible from the passenger seat at night. */
  interiorLight: THREE.PointLight;
  /** Shared by the ceiling panels and the cove strips — what makes the windows read as
   * lit from outside. */
  interiorPanelMaterial: THREE.MeshStandardMaterial;
  /** The saloon's next-stop sign, facing back down the bus toward the seats. */
  interiorSign: THREE.Mesh;
  /** Amber dot-matrix strip under the next-stop sign, running what is nearby. */
  proximitySign: THREE.Mesh;
  display: THREE.Mesh;
  dispose(): void;
}

/**
 * Serialises the bus model to a glTF 2.0 JSON string. All meshes, materials, and
 * canvas-based textures are baked into the document; non-mesh objects (lights, groups
 * without geometry) are omitted because glTF has no equivalent for them.
 */
export async function exportBusModelToGLTF(model: BusModel): Promise<string> {
  const { exportObject3D } = await import('../models/exportObject3D');
  return (await exportObject3D(model.group, 'gltf')).blob.text();
}

/**
 * Serialises the bus model to a glTF 2.0 binary (.glb) ArrayBuffer. Suitable for
 * writing to a file or feeding to a 3D engine that prefers the binary container.
 */
export async function exportBusModelToGLB(model: BusModel): Promise<ArrayBuffer> {
  const { exportObject3D } = await import('../models/exportObject3D');
  return (await exportObject3D(model.group, 'glb')).blob.arrayBuffer();
}

interface DisplayCanvas {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
}

function createDisplayCanvas(): DisplayCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  let context: CanvasRenderingContext2D | null = null;
  if (!navigator.userAgent.toLowerCase().includes('jsdom')) {
    try {
      context = canvas.getContext('2d');
    } catch {
      // A texture update still occurs in non-canvas environments.
    }
  }
  return { canvas, context };
}

function paintDisplay(display: THREE.Mesh, text: string): void {
  const normalized = (text.trim() || DISPLAY_FALLBACK).toLocaleUpperCase().slice(0, 24);
  if (display.userData.text === normalized) return;
  display.userData.text = normalized;
  const { canvas, context } = display.userData.displayCanvas as DisplayCanvas;
  if (context) {
    context.fillStyle = '#120b02';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffad32';
    context.font = '700 46px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(normalized, canvas.width / 2, canvas.height / 2, canvas.width - 24);
  }
  const material = display.material as THREE.MeshBasicMaterial;
  if (material.map) material.map.needsUpdate = true;
}

/**
 * The saloon sign: a two-line dot-matrix panel reading "NEXT STOP" over the destination
 * and how far is left to it. Painted separately from the destination blind on the front
 * of the bus, which faces the street and carries one line for people outside.
 */
function paintInteriorSign(sign: THREE.Mesh, stop: string, remaining: string): void {
  const key = `${stop}|${remaining}`;
  if (sign.userData.text === key) return;
  sign.userData.text = key;
  const { canvas, context } = sign.userData.displayCanvas as DisplayCanvas;
  if (context) {
    context.fillStyle = '#0a0d0b';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = '#7bd88f';
    context.font = '700 22px monospace';
    context.fillText('NEXT STOP', 18, 26);
    context.fillStyle = '#eaf6ec';
    context.font = '700 38px monospace';
    context.fillText(stop.toLocaleUpperCase().slice(0, 18), 18, 68, canvas.width - 150);
    context.fillStyle = '#7bd88f';
    context.font = '700 30px monospace';
    context.textAlign = 'right';
    context.fillText(remaining, canvas.width - 18, 68);
  }
  const material = sign.material as THREE.MeshBasicMaterial;
  if (material.map) material.map.needsUpdate = true;
}

/** Arrow glyph per bearing, matching the six directions the runtime's nearby scan
 * reports. Read from the saloon, facing back down the bus, so these are as seen by a
 * seated passenger looking forward through the windscreen. */
const DIRECTION_ARROWS: Record<string, string> = {
  ahead: '↑',
  'ahead-left': '↖',
  'ahead-right': '↗',
  left: '←',
  right: '→',
  behind: '↓',
};

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters)}m`;
}

/** Spacing of the simulated LED grid, in canvas pixels. */
const LED_PITCH = 4;

/**
 * The proximity strip: what is around the bus right now, as a real vehicle's amber
 * dot-matrix info line.
 *
 * Drawn as solid text and then masked by a grid of dark lines, rather than by plotting
 * individual dots. Both land in the same place visually at the size this is read from,
 * and the mask keeps the text rendering to one fillText call rather than a per-glyph
 * bitmap the module would have to carry.
 */
function paintProximitySign(sign: THREE.Mesh, line: string): void {
  if (sign.userData.text === line) return;
  sign.userData.text = line;
  const { canvas, context } = sign.userData.displayCanvas as DisplayCanvas;
  if (context) {
    context.fillStyle = '#0b0700';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffb347';
    context.font = '700 30px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(line, canvas.width / 2, canvas.height / 2, canvas.width - 16);

    context.fillStyle = '#0b0700';
    for (let x = 0; x < canvas.width; x += LED_PITCH) context.fillRect(x, 0, 1, canvas.height);
    for (let y = 0; y < canvas.height; y += LED_PITCH) context.fillRect(0, y, canvas.width, 1);
  }
  const material = sign.material as THREE.MeshBasicMaterial;
  if (material.map) material.map.needsUpdate = true;
}

function disposeBus(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

/** Inclusive bounds along one axis, in the bus's local frame. */
type Span = readonly [number, number];

export function createBusModel(): BusModel {
  const group = new THREE.Group();
  group.name = 'bus';
  group.rotation.order = 'YXZ';

  const red = new THREE.MeshStandardMaterial({ color: 0x8f3631, roughness: 0.7, metalness: 0.08 });
  const lowerRed = new THREE.MeshStandardMaterial({ color: 0x5e2927, roughness: 0.88 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x17191a, roughness: 0.9 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2a2c2d, roughness: 0.75, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x91adb2,
    roughness: 0.2,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
  });
  const seatMaterial = new THREE.MeshStandardMaterial({ color: 0x334c59, roughness: 0.95 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9b9b91, roughness: 0.45, metalness: 0.55 });
  const hubMaterial = new THREE.MeshStandardMaterial({ color: 0x8c8b84, roughness: 0.5, metalness: 0.5 });
  /**
   * The cab glazing. Smoked rather than clear: the partition behind the driver is the one
   * pane on the bus that exists to keep people out of the cab, and a dark tint is both
   * what a real one has and what stops the driver's console reading as a bright object
   * floating in the middle of the saloon when the interior lights come up.
   */
  const tintedGlass = new THREE.MeshStandardMaterial({
    color: 0x1c2a2b,
    roughness: 0.12,
    metalness: 0.1,
    transparent: true,
    opacity: 0.62,
    side: THREE.DoubleSide,
  });

  const addMesh = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    shadows = true,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
    return mesh;
  };

  /**
   * A body panel given by the box it occupies rather than by a size and a centre.
   * Everything on the shell is placed this way so that "the window band runs from the
   * front bulkhead to the back one" is a statement about two numbers that can be checked
   * against the panel above it, instead of arithmetic hidden in a position argument.
   */
  const panel = (
    name: string,
    material: THREE.Material,
    x: Span,
    y: Span,
    z: Span,
    shadows = true,
  ) => addMesh(
    name,
    new THREE.BoxGeometry(x[1] - x[0], y[1] - y[0], z[1] - z[0]),
    material,
    [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2],
    shadows,
  );

  // --- Structure -----------------------------------------------------------------
  // The floor runs wider than the saloon's clear width so its edges are buried inside
  // the side walls rather than meeting them at a shared plane.
  panel('bus:floor', dark, [-1.26, 1.26], [0.47, BUS_FLOOR_Y], [-5.44, 5.44]);
  // The roof stands a centimetre proud all round: a drip rail on the real thing, and the
  // simplest way to keep its skirt out of the plane of the side panels.
  panel('bus:body-roof', red, [-1.31, 1.31], [ROOF_Y, 3.06], [-5.53, 5.53]);

  // --- Sides ---------------------------------------------------------------------
  // The window band spans the whole length of the saloon on both sides and is recessed
  // 5mm into the skin, so the glass reaches the corner pillars instead of stopping short
  // and leaving a strip of body colour where a window should be.
  const glassX: Span = [1.215, 1.295];
  const glassY: Span = [1.72, 2.68];
  const fasciaY: Span = [CANT_RAIL_Y, 2.96];
  /**
   * Below the waist the side splits in two: an unbroken sill band, and a skirt that stops
   * either side of each axle. The gaps are the wheel arches — without them the body is a
   * slab with the tyres entirely swallowed by it, which is what made the bus read as a
   * tram on rails rather than as something standing on wheels.
   */
  const sillY: Span = [1.2, WAIST_Y];
  const skirtY: Span = [0.3, 1.2];
  const ARCH_CUTS: readonly Span[] = [[-HALF_LENGTH, -4.35], [-2.95, 3.05], [4.45, HALF_LENGTH]];

  panel('bus:left-sill', lowerRed, [WALL_INNER, HALF_WIDTH], sillY, [-HALF_LENGTH, HALF_LENGTH]);
  panel('bus:left-fascia', red, [WALL_INNER, HALF_WIDTH], fasciaY, [-HALF_LENGTH, HALF_LENGTH]);
  panel('bus:left-windows', glass, glassX, glassY, [-5.42, 5.42], false);
  for (const [index, z] of ARCH_CUTS.entries()) {
    panel(`bus:left-skirt-${index}`, lowerRed, [WALL_INNER, HALF_WIDTH], skirtY, z);
  }

  // The kerb side carries the doorway, so its lower panel and window band are cut either
  // side of it. The door posts overlap both cuts, which is what hides the joint.
  const doorPostBack: Span = [BUS_DOOR_BACK_Z - 0.06, BUS_DOOR_BACK_Z + 0.06];
  const doorPostFront: Span = [BUS_DOOR_FRONT_Z - 0.06, BUS_DOOR_FRONT_Z + 0.06];
  const rightX: Span = [-HALF_WIDTH, -WALL_INNER];
  const rightGlassX: Span = [-1.295, -1.215];
  panel('bus:right-sill-rear', lowerRed, rightX, sillY, [-HALF_LENGTH, doorPostBack[1]]);
  panel('bus:right-sill-front', lowerRed, rightX, sillY, [doorPostFront[0], HALF_LENGTH]);
  panel('bus:right-fascia', red, rightX, fasciaY, [-HALF_LENGTH, HALF_LENGTH]);
  // The doorway takes a bite out of the kerb-side skirt as well as the sill, so each cut
  // is clipped against it; the middle one is the only cut the doorway actually reaches.
  for (const [index, z] of ARCH_CUTS.entries()) {
    if (z[1] <= doorPostBack[1] || z[0] >= doorPostFront[0]) {
      panel(`bus:right-skirt-${index}`, lowerRed, rightX, skirtY, z);
      continue;
    }
    if (z[0] < doorPostBack[1]) panel(`bus:right-skirt-${index}a`, lowerRed, rightX, skirtY, [z[0], doorPostBack[1]]);
    if (z[1] > doorPostFront[0]) panel(`bus:right-skirt-${index}b`, lowerRed, rightX, skirtY, [doorPostFront[0], z[1]]);
    // Under the doorway itself the skirt drops to a riser: the step well is open above
    // it, but the underframe below the floor still needs closing off.
    panel(`bus:right-step-riser-${index}`, lowerRed, rightX, [skirtY[0], BUS_FLOOR_Y + 0.01], [z[0], doorPostFront[0]]);
  }
  panel('bus:right-window-rear', glass, rightGlassX, glassY, [-5.42, doorPostBack[1] - 0.02], false);
  panel('bus:right-window-front', glass, rightGlassX, glassY, [doorPostFront[0] + 0.02, 5.42], false);
  for (const [name, z] of [['back', doorPostBack], ['front', doorPostFront]] as const) {
    panel(`bus:door-post-${name}`, red, [-1.31, -1.19], [BUS_FLOOR_Y, CANT_RAIL_Y + 0.08], z);
  }

  // --- Caps ----------------------------------------------------------------------
  // Front and rear panels are narrower than the shell so their side faces finish inside
  // the side walls: the corner pillars below are what closes the join.
  const capX: Span = [-1.2, 1.2];
  panel('bus:front-lower', lowerRed, capX, [0.44, WAIST_Y], [5.36, 5.5]);
  panel('bus:front-window', glass, [-1.18, 1.18], [1.72, 2.62], [5.4, 5.49], false);
  panel('bus:front-header', red, capX, [2.58, 2.96], [5.36, 5.5]);
  panel('bus:rear-lower', lowerRed, capX, [0.44, WAIST_Y], [-5.5, -5.36]);
  panel('bus:rear-window', glass, [-1.14, 1.14], [1.76, 2.56], [-5.49, -5.4], false);
  panel('bus:rear-header', red, capX, [2.52, 2.96], [-5.5, -5.36]);
  panel('bus:front-bumper', dark, [-1.28, 1.28], [0.28, 0.56], [5.34, 5.58]);
  panel('bus:rear-bumper', dark, [-1.28, 1.28], [0.28, 0.56], [-5.58, -5.34]);

  for (const x of [-1, 1] as const) {
    for (const z of [-1, 1] as const) {
      panel(
        `bus:corner-post-${x}-${z}`,
        red,
        x > 0 ? [1.2, 1.32] : [-1.32, -1.2],
        [1.7, 2.7],
        z > 0 ? [5.34, 5.52] : [-5.52, -5.34],
      );
    }
  }

  // Window pillars, sized so their top and bottom faces clear the glass band rather than
  // sitting exactly on its edges — the previous posts were the same 0.9m tall as the
  // glass, which put two horizontal faces in the same plane the whole length of the bus.
  const pillar = (side: number, z: number) => panel(
    `bus:window-post-${side}-${z}`,
    red,
    side > 0 ? [1.2, 1.32] : [-1.32, -1.2],
    [1.68, 2.72],
    [z - 0.07, z + 0.07],
  );
  // Same grid on both sides, so the pillars line up across the bus rather than drifting
  // out of rhythm — the kerb side just drops the one post the doorway would otherwise
  // stand in (-2.2, inside the clear opening between doorPostBack and doorPostFront).
  const WINDOW_POST_GRID = [-4.4, -2.2, 0, 2.2, 4.4] as const;
  for (const z of WINDOW_POST_GRID) pillar(1, z);
  for (const z of WINDOW_POST_GRID) {
    if (z > doorPostBack[1] && z < doorPostFront[0]) continue;
    pillar(-1, z);
  }

  // --- Running gear --------------------------------------------------------------
  // Tyres stay inside the body line (|x| < WALL_INNER) so nothing pokes through the side
  // panels; what reads as a wheel arch is the trim hoop, which sits just outside the skin.
  //
  // The rotational axis is baked into the geometry (rather than left as a per-mesh
  // rotation.z) so each wheel's own rotation.x is free to roll it as the bus moves,
  // with no Euler composition between a fixed tilt and a changing spin.
  const tyreGeometry = new THREE.CylinderGeometry(BUS_WHEEL_RADIUS, BUS_WHEEL_RADIUS, 0.28, 20).rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12).rotateZ(Math.PI / 2);

  /** One tyre and its hub on a shared roll axle, placed relative to `parent`. `side` is
   * which way the hub face points, so the dish is always on the outside of the wheel.
   * Returns the axle group so the runtime can spin the wheel as the bus travels. */
  const addWheel = (
    parent: THREE.Object3D,
    name: string,
    position: [number, number, number],
    side: number,
  ): THREE.Group => {
    const axle = new THREE.Group();
    axle.name = `${name}-axle`;
    axle.position.set(...position);
    const tyre = new THREE.Mesh(tyreGeometry, dark);
    tyre.name = name;
    tyre.castShadow = true;
    const hub = new THREE.Mesh(hubGeometry, hubMaterial);
    hub.position.x = side * 0.02;
    axle.add(tyre, hub);
    parent.add(axle);
    return axle;
  };

  // Twin tyres on the drive axle, single on the steered one — the giveaway that a vehicle
  // this long is a bus and not a coachbuilt lorry.
  const wheelRoll: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    wheelRoll.push(addWheel(group, `bus:wheel-rear-outer-${side}`, [side * 1.02, BUS_AXLE_Y, BUS_REAR_AXLE_Z], side));
    wheelRoll.push(addWheel(group, `bus:wheel-rear-inner-${side}`, [side * 0.72, BUS_AXLE_Y, BUS_REAR_AXLE_Z], side));
  }

  // Each front wheel gets its own group standing on its kingpin, so steering turns the
  // wheel where it sits rather than swinging it about the centreline of the bus. The roll
  // axle nests inside it, so a steered wheel still spins about its own (now turned) axis.
  const frontWheels = [1, -1].map((side) => {
    const steerGroup = new THREE.Group();
    steerGroup.name = side > 0 ? 'bus:front-wheel-left' : 'bus:front-wheel-right';
    steerGroup.position.set(side * 1.02, BUS_AXLE_Y, BUS_FRONT_AXLE_Z);
    wheelRoll.push(addWheel(steerGroup, `bus:wheel-front-${side}`, [0, 0, 0], side));
    group.add(steerGroup);
    return steerGroup;
  }) as [THREE.Group, THREE.Group];

  // Arch hoops: an open half-cylinder lying on its side, just proud of the skin. Cheaper
  // and cleaner than cutting the side panels, and it is the arch line you actually see.
  const archGeometry = new THREE.CylinderGeometry(0.68, 0.68, 0.1, 18, 1, true, 0, Math.PI);
  for (const side of [-1, 1] as const) {
    for (const z of [BUS_FRONT_AXLE_Z, BUS_REAR_AXLE_Z]) {
      const arch = addMesh(`bus:wheel-arch-${side}-${z}`, archGeometry, trim, [side * 1.24, BUS_AXLE_Y, z], false);
      arch.rotation.z = Math.PI / 2;
    }
  }

  // Valance under the waist, cut around both axles so the arches read as openings.
  for (const side of [-1, 1] as const) {
    const x: Span = side > 0 ? [1.2, 1.28] : [-1.28, -1.2];
    for (const z of [[-5.3, -3.6], [-2.1, 3.0], [4.5, 5.3]] as const) {
      panel(`bus:valance-${side}-${z[0]}`, dark, x, [0.3, 0.62], z, false);
    }
  }

  // --- Saloon --------------------------------------------------------------------
  const cushionGeometry = new THREE.BoxGeometry(0.52, 0.1, 0.5);
  const backrestGeometry = new THREE.BoxGeometry(0.52, 0.6, 0.09);
  for (let row = 0; row < 7; row += 1) {
    const z = -4.5 + row * 1.05;
    for (const x of [-0.88, 0.88]) {
      if (x < 0 && z > BUS_DOOR_BACK_Z - 0.35 && z < BUS_DOOR_FRONT_Z + 0.35) continue;
      addMesh(`bus:seat-cushion-${row}-${x}`, cushionGeometry, seatMaterial, [x, 1.06, z], false);
      addMesh(`bus:seat-back-${row}-${x}`, backrestGeometry, seatMaterial, [x, 1.41, z - 0.2], false);
    }
  }

  const poleGeometry = new THREE.CylinderGeometry(0.028, 0.028, 2.2, 8);
  for (const x of [-0.46, 0.46]) {
    for (const z of [-3.4, -0.2, 3]) {
      addMesh(`bus:pole-${x}-${z}`, poleGeometry, metal, [x, 1.71, z], false);
    }
  }

  // --- Cab -----------------------------------------------------------------------
  panel('bus:driver-console', dark, [0.32, 1.04], [BUS_FLOOR_Y, 1.3], [4.58, 5.13], false);
  // The cab is boxed in on two sides: a solid panel to waist height, tinted glass above.
  // The transverse pair is the partition directly behind the driver's shoulder.
  panel('bus:driver-partition', lowerRed, [0.14, 0.22], [BUS_FLOOR_Y, 1.5], [4.0, 5.05], false);
  panel('bus:driver-screen', tintedGlass, [0.145, 0.215], [1.5, 2.3], [4.0, 5.05], false);
  panel('bus:cab-back', lowerRed, [0.14, 1.22], [BUS_FLOOR_Y, 1.3], [3.9, 3.96], false);
  panel('bus:cab-back-screen', tintedGlass, [0.145, 1.215], [1.3, 2.2], [3.905, 3.955], false);

  const driver = new THREE.Group();
  driver.name = 'bus:driver';
  driver.position.set(0.68, 1.2, 4.35);
  const driverMaterial = new THREE.MeshStandardMaterial({ color: 0x273d4c, roughness: 0.9 });
  const driverBody = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.62, 0.28), driverMaterial);
  driverBody.position.y = 0.16;
  const driverHead = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), driverMaterial);
  driverHead.position.y = 0.62;
  driver.add(driverBody, driverHead);
  group.add(driver);

  // Laid nearly flat on its column, the way a bus wheel is. The tilt lives on the group
  // so the rim can spin about its own axis when the front wheels turn.
  const steeringWheel = new THREE.Group();
  steeringWheel.name = 'bus:steering-wheel';
  steeringWheel.position.set(0.68, 1.55, 4.6);
  steeringWheel.rotation.x = 1.15;
  const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.035, 8, 20), dark);
  wheelRim.name = 'bus:steering-wheel-rim';
  steeringWheel.add(wheelRim);
  group.add(steeringWheel);

  // --- Doors ---------------------------------------------------------------------
  // A pivot door, not a hinged flap: each leaf hangs on a vertical axle down its own
  // centre line, so opening swings its outer half into the street and its inner half back
  // along the saloon wall. That is the movement a bus door actually makes, and unlike a
  // hinged leaf it never sweeps through the kerb.
  const door = new THREE.Group();
  door.name = 'bus:door';
  door.position.set(BUS_DOOR_SIDE_X, 0, 0);
  const clearOpening: Span = [doorPostBack[1], doorPostFront[0]];
  const leafSpan = (clearOpening[1] - clearOpening[0]) / 2;
  const leafGeometry = new THREE.BoxGeometry(0.05, BUS_DOOR_HEIGHT - 0.1, leafSpan - 0.02);
  const doorLeaves = ([-1, 1] as const).map((side) => {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'bus:door-leaf-rear' : 'bus:door-leaf-front';
    pivot.position.set(0, 0, clearOpening[0] + leafSpan * (side < 0 ? 0.5 : 1.5));
    const leaf = new THREE.Mesh(leafGeometry, glass);
    leaf.name = `${pivot.name}-glass`;
    leaf.position.y = BUS_FLOOR_Y + (BUS_DOOR_HEIGHT - 0.1) / 2;
    pivot.add(leaf);
    door.add(pivot);
    return pivot;
  }) as [THREE.Group, THREE.Group];
  group.add(door);

  // Paint patches sit a few millimetres proud of the panel they are on, which is under
  // the depth buffer's resolution at any distance the bus is seen from. polygonOffset is
  // inert under this scene's log depth buffer, so the separation comes from the bias.
  const scruffMaterial = applyLogDepthBias(new THREE.MeshStandardMaterial({
    color: 0x6e3530,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  }), DEPTH_BIAS.decal);
  const patchGeometry = new THREE.BoxGeometry(0.012, 0.22, 0.7);
  const patchTransforms: ReadonlyArray<readonly [number, number, number, number]> = [
    [1.307, 0.83, -4.4, 0], [1.307, 1.24, -1.1, 0],
    [1.307, 0.91, 2.6, 0], [-1.307, 0.79, -4.45, 0],
    [-1.307, 1.18, 0.4, 0], [-1.307, 0.87, 3.4, 0],
    [-0.72, 0.86, 5.51, Math.PI / 2], [0.74, 1.26, -5.51, Math.PI / 2],
  ];
  patchTransforms.forEach(([x, y, z, rotation], index) => {
    const patch = addMesh(`bus:scruff-${index}`, patchGeometry, scruffMaterial, [x, y, z], false);
    patch.rotation.y = rotation;
  });

  // The destination blind, on the outside of the windscreen header facing the street.
  // It is read by people waiting at a stop, not by anyone aboard — which is why it sits
  // just proud of the front glass and faces forward, +z.
  const displayCanvas = createDisplayCanvas();
  const displayTexture = new THREE.CanvasTexture(displayCanvas.canvas);
  displayTexture.colorSpace = THREE.SRGBColorSpace;
  const display = addMesh(
    'bus:display',
    new THREE.PlaneGeometry(1.55, 0.29),
    new THREE.MeshBasicMaterial({ color: 0xffad32, map: displayTexture, toneMapped: false }),
    [0, 2.76, 5.52],
    false,
  );
  display.userData.displayCanvas = displayCanvas;
  paintDisplay(display, DISPLAY_FALLBACK);

  // --- Exterior lamps ------------------------------------------------------------
  const headlightLensMaterial = new THREE.MeshStandardMaterial({
    color: 0xffeccb,
    emissive: 0xffca80,
    emissiveIntensity: 0.9,
    toneMapped: false,
  });
  const lensGeometry = new THREE.CircleGeometry(0.17, 18);
  const headlights = [0.72, -0.72].map((x, index) => {
    addMesh(`bus:headlight-lens-${index}`, lensGeometry, headlightLensMaterial, [x, 1.02, 5.51], false);
    // Warm, wide and soft rather than a hard white cone: an old bus runs tungsten sealed
    // beams, and the pool they lay down is the cosiest thing about driving one at night.
    const light = new THREE.SpotLight(0xffd6a0, 0, 60, Math.PI / 6, 0.65, 1.5);
    light.name = index === 0 ? 'bus:headlight-left' : 'bus:headlight-right';
    light.position.set(x, 1.02, 5.5);
    light.castShadow = false;
    const target = new THREE.Object3D();
    target.position.set(x, 0.1, 22);
    group.add(light, target);
    light.target = target;
    return light;
  }) as [THREE.SpotLight, THREE.SpotLight];

  /**
   * Marker and tail lamps: emissive only. They illuminate nothing, which is also true of
   * the real things — what they do is give the bus an outline after dark, and a row of
   * warm amber pinpricks along the roofline is most of what makes an old one look alive
   * from across a junction.
   */
  const markerLampMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc463,
    emissive: 0xffa32e,
    emissiveIntensity: 0,
    toneMapped: false,
  });
  const tailLampMaterial = new THREE.MeshStandardMaterial({
    color: 0x7d1a14,
    emissive: 0xff3a1c,
    emissiveIntensity: 0,
    toneMapped: false,
  });
  // On the header face and the cant rail, both just proud of the panel behind them —
  // above the roof line they would be swallowed by the roof's own overhang.
  for (const x of [-0.78, 0, 0.78]) {
    panel(`bus:marker-front-${x}`, markerLampMaterial, [x - 0.07, x + 0.07], [2.82, 2.9], [5.5, 5.55], false);
  }
  for (const side of [-1, 1] as const) {
    panel(
      `bus:marker-side-${side}`,
      markerLampMaterial,
      side > 0 ? [1.301, 1.34] : [-1.34, -1.301],
      [2.74, 2.84],
      [-1.2, -1.0],
      false,
    );
  }
  for (const x of [-0.82, 0.82]) {
    panel(`bus:tail-lamp-${x}`, tailLampMaterial, [x - 0.13, x + 0.13], [0.86, 1.16], [-5.56, -5.5], false);
  }

  /**
   * Saloon lighting: two ceiling panels, two cove strips down the sides, and one point
   * light between them.
   *
   * The emissive surfaces are what you see from outside — a lit bus at night is
   * recognisable by its row of windows glowing long before you can make out the vehicle —
   * and the point light is what makes the seats and grab rails inside actually visible
   * from the cockpit seat. One light for the whole saloon is affordable in a way the
   * city's lamp posts are not (see SceneLighting.nightFill for why those are faked):
   * there is only ever one bus. The coves are how the light is spread without paying for
   * a second one.
   */
  const interiorPanelMaterial = new THREE.MeshStandardMaterial({
    color: 0xffe7c4,
    emissive: 0xffcf92,
    emissiveIntensity: 0,
    toneMapped: false,
  });
  // A cream liner under the roof. The roof panel's underside is body colour, which in the
  // saloon's own dim light reads as a black void overhead however warm the lamps are;
  // lining it is what gives the ceiling something for them to fall on.
  panel(
    'bus:ceiling-liner',
    new THREE.MeshStandardMaterial({ color: 0xe4d8c4, roughness: 0.95 }),
    [-1.2, 1.2],
    [2.885, 2.94],
    [-5.4, 5.4],
    false,
  );
  // A row of fixtures on an even pitch, the way a real saloon's strip lights run, rather
  // than two long panels either side of one wide gap — from a seat near the middle the
  // gap read as a single fixture floating in an otherwise dark ceiling instead of a row
  // of light running the length of the bus.
  const CEILING_LIGHT_PITCH = 1.3;
  const CEILING_LIGHT_LENGTH = 0.85;
  for (let z = -4.55, index = 0; z < 4.6; z += CEILING_LIGHT_PITCH, index += 1) {
    panel(
      `bus:interior-panel-${index}`,
      interiorPanelMaterial,
      [-0.34, 0.34],
      [2.84, 2.92],
      [z - CEILING_LIGHT_LENGTH / 2, z + CEILING_LIGHT_LENGTH / 2],
      false,
    );
  }
  for (const side of [-1, 1] as const) {
    panel(
      `bus:interior-cove-${side}`,
      interiorPanelMaterial,
      side > 0 ? [1.02, 1.16] : [-1.16, -1.02],
      [2.8, 2.86],
      [-5.1, 5.1],
      false,
    );
  }

  // Mounted high at the front of the saloon facing back down the bus, which is where a
  // real one goes and what the passenger seat (back-left, see BUS_SEAT_OFFSET) looks at.
  // It hangs clear of the cab screen behind it so neither cuts through the other.
  const SIGN_Z = 3.7;
  const signCanvas = createDisplayCanvas();
  signCanvas.canvas.height = 128;
  const signTexture = new THREE.CanvasTexture(signCanvas.canvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  const interiorSign = addMesh(
    'bus:interior-sign',
    new THREE.PlaneGeometry(1.7, 0.42),
    new THREE.MeshBasicMaterial({ map: signTexture, toneMapped: false }),
    [0, 2.5, SIGN_Z],
    false,
  );
  // Turned to face back down the saloon: the seats are at negative z, and a sign facing
  // the windscreen is a sign nobody aboard can read.
  interiorSign.rotation.y = Math.PI;
  interiorSign.userData.displayCanvas = signCanvas;
  paintInteriorSign(interiorSign, DISPLAY_FALLBACK, '');

  // Directly under the next-stop sign, where a real bus puts its running info line.
  const proximityCanvas = createDisplayCanvas();
  proximityCanvas.canvas.height = 64;
  const proximityTexture = new THREE.CanvasTexture(proximityCanvas.canvas);
  proximityTexture.colorSpace = THREE.SRGBColorSpace;
  const proximitySign = addMesh(
    'bus:proximity-sign',
    new THREE.PlaneGeometry(1.7, 0.21),
    new THREE.MeshBasicMaterial({ map: proximityTexture, toneMapped: false }),
    [0, 2.18, SIGN_Z],
    false,
  );
  proximitySign.rotation.y = Math.PI;
  proximitySign.userData.displayCanvas = proximityCanvas;
  paintProximitySign(proximitySign, PROXIMITY_FALLBACK);

  const interiorLight = new THREE.PointLight(0xffc98d, 0, 11, 1.6);
  interiorLight.name = 'bus:interior-light';
  interiorLight.position.set(0, 2.62, 0.4);
  interiorLight.castShadow = false;
  group.add(interiorLight);

  let disposed = false;
  const model: BusModel = {
    group,
    door,
    frontWheels,
    wheelRoll,
    steeringWheel,
    headlights,
    interiorLight,
    interiorPanelMaterial,
    interiorSign,
    proximitySign,
    display,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeBus(group);
    },
  };

  nightLampMaterials.set(model, [markerLampMaterial, tailLampMaterial]);
  doorLeafGroups.set(model, doorLeaves);
  shellWheelBindings.set(model, {
    wheels: [],
    state: { leftSteer: 0, rightSteer: 0, rollRadians: 0, travel: [] },
  });
  setBusDoorOpen(model, 0);
  setBusSteer(model, 0);
  return model;
}

/**
 * Per-model state that only the setters below touch. Kept off BusModel because it is
 * plumbing rather than something a caller has any reason to reach into, and a WeakMap
 * means a disposed bus takes its entries with it.
 */
const nightLampMaterials = new WeakMap<BusModel, THREE.MeshStandardMaterial[]>();
const doorLeafGroups = new WeakMap<BusModel, [THREE.Group, THREE.Group]>();

/**
 * The authored shell's wheels, and the running-gear state the three setters below build
 * between them.
 *
 * The state is kept whether or not a shell has arrived, because the shell arrives a beat
 * into the session and can arrive mid-ride: `applyBusShell` replays what is here the
 * moment it lands, so a bus that was already at half lock does not snap its new wheels
 * straight for a frame.
 */
interface BusShellWheelBinding {
  wheels: readonly BusShellWheel[];
  state: BusShellWheelState;
}
const shellWheelBindings = new WeakMap<BusModel, BusShellWheelBinding>();


/**
 * Opens the doors, `fraction` running 0 (shut) to 1 (fully open).
 *
 * The two leaves turn opposite ways so the gap grows from the middle of the doorway
 * outward, each one pivoting about its own centre — see the door assembly above for why
 * that is the movement rather than a swing from one edge.
 */
export function setBusDoorOpen(model: BusModel, fraction: number): void {
  const open = Math.max(0, Math.min(1, fraction));
  const leaves = doorLeafGroups.get(model);
  if (!leaves) return;
  const [rear, front] = leaves;
  rear.rotation.y = -BUS_DOOR_OPEN_ANGLE * open;
  front.rotation.y = BUS_DOOR_OPEN_ANGLE * open;
  model.door.userData.openFraction = open;
}

/**
 * Points the front wheels, `angle` being the virtual bicycle-model (centre) steering
 * angle in radians, positive to the left, and turns the driver's wheel to match.
 *
 * The two front wheels do not receive the same angle: they are split by
 * computeAckermannAngles (busGeometry.ts) into distinct left/right angles so both point at
 * the turn's true centre rather than at parallel angles, per backlog item 2. frontWheels[0]
 * is the left steer group (built at side = +1, `bus:front-wheel-left`) and frontWheels[1]
 * is the right one (side = -1) — see the construction above.
 */
export function setBusSteer(model: BusModel, angle: number): void {
  const clamped = Math.max(-BUS_MAX_STEER, Math.min(BUS_MAX_STEER, angle));
  const { left, right } = computeAckermannAngles(clamped, BUS_WHEELBASE, BUS_DIMENSIONS.track);
  const [leftWheel, rightWheel] = model.frontWheels;
  leftWheel.rotation.y = left;
  rightWheel.rotation.y = right;
  // The authored wheels take the same two angles rather than re-deriving them: one
  // Ackermann split per frame, and no way for the two sets of wheels to disagree.
  const binding = shellWheelBindings.get(model);
  if (binding) {
    binding.state.leftSteer = left;
    binding.state.rightSteer = right;
    updateBusShellWheels(binding.wheels, binding.state);
  }
  // The rim lies almost flat and faces the driver, so a left lock is a turn the other way
  // about its own axis. Driven off the commanded centre angle, not either wheel's own.
  model.steeringWheel.children[0].rotation.z = -clamped * STEERING_RATIO;
}

/**
 * Spins every wheel to `radians` about its own axle. One shared angle rather than one per
 * wheel: all six run the same tyre and this bus never skids or drives in reverse, so
 * there is nothing that would make them turn at different rates.
 *
 * `radians` is the wheel's absolute roll, not a delta — the caller accumulates
 * `distance / BUS_WHEEL_RADIUS` itself (see svartaksiRuntime.tsx), the same way busTraveledRef
 * accumulates distance along the route.
 */
export function setBusWheelRoll(model: BusModel, radians: number): void {
  for (const wheel of model.wheelRoll) wheel.rotation.x = radians;
  const binding = shellWheelBindings.get(model);
  if (binding) {
    binding.state.rollRadians = radians;
    updateBusShellWheels(binding.wheels, binding.state);
  }
}

/**
 * Where each wheel sits within its arch, in metres from the axle's resting height.
 *
 * `model.wheelRoll` is built rear-first — outer then inner on the left, outer then inner
 * on the right — and then the two front wheels, which are the axles nested inside their
 * own kingpin groups. Those front axles sit at the origin of a group already placed at
 * BUS_AXLE_Y, so their travel is written straight to the axle's y; the rear four are
 * placed at BUS_AXLE_Y themselves, so theirs is written relative to it.
 *
 * `travel` must have one entry per wheel in that order; short arrays leave the rest
 * where they are, so a caller with a four-corner model can drive just the corners.
 */
export const BUS_WHEEL_LAYOUT: ReadonlyArray<{ x: number; z: number; front: boolean }> = [
  { x: -BUS_HALF_TRACK, z: BUS_REAR_AXLE_Z, front: false },
  { x: -BUS_INNER_HALF_TRACK, z: BUS_REAR_AXLE_Z, front: false },
  { x: BUS_HALF_TRACK, z: BUS_REAR_AXLE_Z, front: false },
  { x: BUS_INNER_HALF_TRACK, z: BUS_REAR_AXLE_Z, front: false },
  { x: BUS_HALF_TRACK, z: BUS_FRONT_AXLE_Z, front: true },
  { x: -BUS_HALF_TRACK, z: BUS_FRONT_AXLE_Z, front: true },
];

export function setBusWheelTravel(model: BusModel, travel: readonly number[]): void {
  for (let index = 0; index < model.wheelRoll.length && index < travel.length; index += 1) {
    const layout = BUS_WHEEL_LAYOUT[index];
    model.wheelRoll[index].position.y = (layout?.front ? 0 : BUS_AXLE_Y) + travel[index];
  }
  // The authored wheels read the same array through their own suspensionIndex: the asset
  // has four wheels where the sheet has six, so each rear one takes the travel of the
  // outer wheel of its dual pair.
  const binding = shellWheelBindings.get(model);
  if (binding) {
    binding.state.travel = travel;
    updateBusShellWheels(binding.wheels, binding.state);
  }
}

/**
 * Peak saloon brightness. A bus at night is dim and warm inside, not a second pair of
 * headlights pointed at its own seats — and at the previous values it read as the
 * latter: the ceiling panels blew out to flat white, the seats and grab rails lost all
 * of their shading to the fill, and the windows glared rather than glowed. Roughly
 * halved so the interior stays legible from the passenger seat while the world outside
 * the windows is still the brighter thing to look at, which is the whole point of
 * riding.
 */
const INTERIOR_LIGHT_INTENSITY = 1.35;
const INTERIOR_PANEL_EMISSIVE = 0.3;
/**
 * What the saloon runs at in broad daylight. Not zero: the roof shades the whole interior
 * from the sun, so with the lamps fully off the seats, the liner and the grab rails all
 * collapse to near-black in the middle of the afternoon — which is both unlike a real bus
 * (they run their interior lighting all day) and the least inviting thing a vehicle you
 * spend the whole ride sitting inside could do.
 */
const INTERIOR_DAY_FLOOR = 0.3;
/** Marker and tail lamps come up with the headlights, not with dusk: they are a legal
 * signal, and a bus showing tail lamps in the afternoon looks broken. */
const MARKER_EMISSIVE = 1.1;

export function setBusNightFactor(model: BusModel, nightFactor: number): void {
  const intensity = nightFactor >= 0.35 ? 34 * nightFactor : 0;
  for (const headlight of model.headlights) headlight.intensity = intensity;
  // The saloon comes up with dusk rather than waiting for the headlight threshold —
  // interior lighting is the first thing switched on and the last thing off — and it
  // never goes fully out, for the reason INTERIOR_DAY_FLOOR gives.
  const interior = Math.max(0, Math.min(1, nightFactor));
  const level = INTERIOR_DAY_FLOOR + (1 - INTERIOR_DAY_FLOOR) * interior;
  model.interiorLight.intensity = INTERIOR_LIGHT_INTENSITY * level;
  model.interiorPanelMaterial.emissiveIntensity = INTERIOR_PANEL_EMISSIVE * level;
  const lamps = nightLampMaterials.get(model);
  if (lamps) {
    const glow = nightFactor >= 0.35 ? MARKER_EMISSIVE * interior : 0;
    for (const lamp of lamps) lamp.emissiveIntensity = glow;
  }
}

/**
 * Updates the saloon sign. `metersRemaining` is null before a ride has a destination —
 * the sign then names the stop without claiming a distance to it.
 */
export function setBusNextStop(
  model: BusModel,
  stop: string,
  metersRemaining: number | null,
): void {
  const remaining = metersRemaining === null || !Number.isFinite(metersRemaining)
    ? ''
    : metersRemaining >= 1000
      ? `${(metersRemaining / 1000).toFixed(1)} km`
      // Rounded to 10m so the sign is not a flickering odometer at 14 m/s.
      : `${Math.max(0, Math.round(metersRemaining / 10) * 10)} m`;
  paintInteriorSign(model.interiorSign, stop, remaining);
}

export function setBusDisplayText(model: BusModel, text: string): void {
  paintDisplay(model.display, text);
}

export interface BusProximityEntry {
  name: string;
  distance: number;
  direction: string;
}

/** How many places fit on the strip before it stops being readable at a glance. */
const PROXIMITY_ENTRIES = 2;
/** Characters kept per name. Long Swedish place names would otherwise squeeze the
 * distances off the end of the strip. */
const PROXIMITY_NAME_LENGTH = 13;

/**
 * Updates the proximity strip from the same nearby-places scan the HUD uses, which is
 * already sorted by how relevant each place is to where the bus is heading — so taking
 * the first couple gives the strip the things a passenger would actually want called
 * out, not merely the two closest.
 */
export function setBusProximity(model: BusModel, entries: BusProximityEntry[]): void {
  const line = entries
    .slice(0, PROXIMITY_ENTRIES)
    .map((entry) => {
      const arrow = DIRECTION_ARROWS[entry.direction] ?? '·';
      const name = entry.name.toLocaleUpperCase().slice(0, PROXIMITY_NAME_LENGTH);
      return `${arrow} ${name} ${formatDistance(entry.distance)}`;
    })
    .join('   ');
  paintProximitySign(model.proximitySign, line || PROXIMITY_FALLBACK);
}

/**
 * The procedural meshes the modelled shell stands in for.
 *
 * Named rather than inferred: `applyBusShell` hides exactly this list, so anything added
 * to the bus later is visible by default and nothing disappears because it happened to
 * match a prefix. Everything absent from this list — the saloon, the doors, the cab, the
 * destination display, the signs — is kept, because the asset does not model it or models
 * it in a place the gameplay does not agree with.
 */
export const BUS_SHELL_MESH_NAMES = [
  'bus:body-roof',
  'bus:front-bumper',
  'bus:front-header',
  'bus:front-lower',
  'bus:front-window',
  'bus:left-fascia',
  'bus:left-sill',
  'bus:left-windows',
  'bus:rear-bumper',
  'bus:rear-header',
  'bus:rear-lower',
  'bus:rear-window',
  'bus:right-fascia',
  'bus:right-sill-front',
  'bus:right-sill-rear',
  'bus:right-window-front',
  'bus:right-window-rear',
] as const;

/** Wheels, arches and the valance between them: hidden with the shell, since the asset
 * models its own running gear at its own arches and the two sets do not sit in the same
 * place. See busShell.ts. */
export const BUS_SHELL_WHEEL_PREFIXES = ['bus:wheel-', 'bus:front-wheel-', 'bus:valance-'] as const;

/**
 * Whether a named object is part of the skin the modelled shell replaces.
 *
 * Pure and exported so the swap is testable against the real model's object names without
 * a loader or a GPU: build the bus, ask this of every child, and the answer is the list of
 * things that will disappear.
 */
export function isBusShellPart(name: string): boolean {
  if ((BUS_SHELL_MESH_NAMES as readonly string[]).includes(name)) return true;
  return BUS_SHELL_WHEEL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Puts the modelled body on the bus, in place.
 *
 * Hides rather than deletes: the runtime, the suspension and the steering all hold
 * references into these groups, and a hidden `Object3D` costs a traversal step where a
 * detached one costs a crash. It also means the swap is reversible — `revealProceduralBusShell`
 * is the whole of the way back, which is what makes the asset a choice rather than a
 * one-way door.
 */
export function applyBusShell(
  model: BusModel, shell: { group: THREE.Object3D; wheels?: readonly BusShellWheel[] },
): void {
  setProceduralShellVisible(model, false);
  model.group.add(shell.group);
  const binding = shellWheelBindings.get(model);
  if (binding) {
    binding.wheels = shell.wheels ?? [];
    // Replay the running gear's current state, since the shell may have landed mid-ride.
    updateBusShellWheels(binding.wheels, binding.state);
  }
}

/** Shows the procedural skin again, for a session that could not load the asset. */
export function revealProceduralBusShell(model: BusModel): void {
  setProceduralShellVisible(model, true);
}

function setProceduralShellVisible(model: BusModel, visible: boolean): void {
  for (const child of model.group.children) {
    if (isBusShellPart(child.name)) child.visible = visible;
  }
}
