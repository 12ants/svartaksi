/**
 * Signalised junctions: where to put them, what colour each head is showing right now,
 * and the instanced geometry that draws them.
 *
 * Nothing in the source data says "this junction has lights" — OpenMapTiles drops the
 * `highway=traffic_signals` nodes entirely, and even raw OSM only tags a fraction of
 * them. So the junctions are *found* from the road network instead: a place where a
 * major road meets another road is one, which is close enough to the real distribution
 * that a drive across town passes lights roughly where it should.
 *
 * The cycle is pure arithmetic over a shared clock (resolveSignalAspect) rather than per
 * junction state, so nothing has to be ticked, nothing drifts, and a junction that was
 * off screen for a minute shows the right aspect the instant it comes back.
 */
import * as THREE from 'three';

import { getRoadFamily } from './roadStyle';
import type { LocalPoint, WorldRoad } from '../world/types';
import { INSPECTION_USER_DATA_KEY, type WorldInspectionRecord } from '../world/inspection';
import { isPointOnAnyRoad } from '../world/roadClearance';

export type SignalAspect = 'red' | 'amber' | 'green';

/** One signal head, controlling one approach into one junction. */
export interface TrafficSignal {
  x: number;
  z: number;
  /** Height of the surface the mast stands on — see BusStopPlacement's own `y`. */
  y?: number;
  /** Yaw the head faces: back down its own approach, at the driver waiting on it. */
  yaw: number;
  /** Which of the junction's two opposed phases this approach belongs to. The two
   * groups are exactly half a cycle apart, which is what makes crossing traffic red
   * while this approach is green. */
  group: 0 | 1;
  /** Seconds this junction's cycle is shifted by, so neighbouring junctions don't all
   * change together. Derived from position, so it is stable across rebuilds. */
  offsetSeconds: number;
}

export const SIGNAL_GREEN_SECONDS = 12;
export const SIGNAL_AMBER_SECONDS = 3;
/** Both directions red between phases — the gap that makes a junction readable rather
 * than a straight swap from one green to the other. */
export const SIGNAL_ALL_RED_SECONDS = 2;
const HALF_CYCLE = SIGNAL_GREEN_SECONDS + SIGNAL_AMBER_SECONDS + SIGNAL_ALL_RED_SECONDS;
export const SIGNAL_CYCLE_SECONDS = HALF_CYCLE * 2;

/**
 * What one head is showing at `timeSeconds`. Total function of the clock: no state, no
 * accumulation, and the same answer on every machine at the same time.
 */
export function resolveSignalAspect(signal: TrafficSignal, timeSeconds: number): SignalAspect {
  const shifted = timeSeconds + signal.offsetSeconds - signal.group * HALF_CYCLE;
  const phase = ((shifted % SIGNAL_CYCLE_SECONDS) + SIGNAL_CYCLE_SECONDS) % SIGNAL_CYCLE_SECONDS;
  if (phase < SIGNAL_GREEN_SECONDS) return 'green';
  if (phase < SIGNAL_GREEN_SECONDS + SIGNAL_AMBER_SECONDS) return 'amber';
  return 'red';
}

/** Grid cell size for the "do these roads meet here" test. A little wider than a large
 * junction so the several vertices a junction is drawn with land in one cell, and far
 * narrower than the spacing between real junctions. */
const JUNCTION_CELL = 14;
/** Spacing of the points a road is tested at. Half a cell, so a road cannot step over a
 * cell without leaving a sample in it. */
const JUNCTION_SAMPLE = JUNCTION_CELL / 2;
/** Junctions closer than this are the same junction seen twice — real signalised
 * crossings in a city centre are rarely closer together than a short block. */
const MIN_JUNCTION_SPACING = 90;
/**
 * What makes a junction big enough to be worth signalling.
 *
 * Two major roads crossing is the clearest case and the one every driver recognises. The
 * second case covers the real T-junction where a main road is joined by a substantial
 * side street: still a major, but crossed by something that is at least a proper
 * two-lane carriageway rather than a service road or a driveway.
 *
 * Signalling every place a major met anything at all — the previous rule — put a full
 * set of four heads on every parking entrance and back lane off a main road, which is
 * both wrong and the single densest piece of street furniture in the world.
 */
const BIG_JUNCTION_CROSS_WIDTH = 9;
/** How far back from the junction centre a head stands. Roughly where a mast sits on a
 * real two-lane approach. */
const ARM_SETBACK = 9;
/** Clearance beyond the approach's own paved edge before planting a mast — the actual
 * side offset is this plus the approach's own half-width, since a fixed offset (the
 * previous approach) sat inside the carriageway on anything wider than an 11m road,
 * which every major-class approach (12-18m) is. */
const ARM_SIDE_CLEARANCE = 1.6;
/** Two approaches whose axes are within this angle are the same street, not a crossing.
 * 35 degrees: a real junction can be well off square, but not nearly parallel. */
const MIN_AXIS_SEPARATION = 0.61;

/** One road's tangent through a junction cell, the width to clear it by, and whether it
 * is a main road — which is what decides if the junction is big enough to signal. */
interface JunctionAxis {
  yaw: number;
  width: number;
  major: boolean;
}

interface JunctionCell {
  sumX: number;
  sumZ: number;
  count: number;
  /** One entry per distinct road passing through, keyed by road id — a road that
   * wanders through several vertices only votes once. */
  axes: Map<string, JunctionAxis>;
  majors: number;
}

/** Angle between two undirected axes, folded into 0..PI/2 — a street and the same
 * street reversed are one axis, not two. */
function axisSeparation(a: number, b: number): number {
  const delta = Math.abs(a - b) % Math.PI;
  return Math.min(delta, Math.PI - delta);
}

/** Deterministic 0..1 from a junction's own position, for its cycle offset. */
function positionSeed(x: number, z: number): number {
  const hash = Math.imul(Math.round(x * 4) | 0, 374_761_393) ^ Math.imul(Math.round(z * 4) | 0, 668_265_263);
  return ((hash >>> 0) % 10_007) / 10_007;
}

/**
 * Finds signalised junctions in a road network and returns one head per approach.
 *
 * Roads are voxelised onto a coarse grid; a cell holding vertices from two or more
 * distinct roads, at least one of them a major road, is a junction. The cells are then
 * taken busiest-first and thinned by distance, so a big multi-way junction drawn as a
 * cluster of cells yields one set of lights rather than five overlapping sets, and a
 * `limit` cut costs the quietest junctions rather than an arbitrary slice.
 */
/** Roads per yield in the junction scan, and candidate junctions per yield in the
 * placement pass. Both loops do a comparable amount of work per item to the road
 * builders', so they take the same chunk size. */
const SIGNAL_CHUNK = 256;

/**
 * The incremental form, which is the real implementation.
 *
 * Finding junctions was one of the stages that ran whole between two of the world
 * builder's yields: it samples every road every few metres, which on a city snapshot is
 * hundreds of thousands of samples in one block. Both passes cut up safely. The scan only
 * ever adds to `cells` — sums, counts and a per-road axis entry — and addition into a map
 * does not care where it was interrupted; the placement pass then walks an explicitly
 * sorted list, so its order is fixed by the sort rather than by how the scan was paused.
 */
export function* findTrafficSignalsJob(
  roads: WorldRoad[],
  limit: number,
): Generator<void, TrafficSignal[], void> {
  if (limit <= 0) return [];
  const cells = new Map<string, JunctionCell>();

  for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
    if (roadIndex > 0 && roadIndex % SIGNAL_CHUNK === 0) yield;
    const road = roads[roadIndex];
    const family = getRoadFamily(road.kind);
    if (family === 'path') continue;
    const points = road.points;
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const yaw = Math.atan2(dx, dz);
      // Sampled along the segment, not just at its ends: two ways that cross without
      // sharing a node — a bridge-free crossing in the source data, or any road drawn
      // as a single straight line through a junction — are still a junction on the
      // ground, and a vertex-only scan misses every one of them.
      const steps = Math.ceil(length / JUNCTION_SAMPLE);
      for (let step = 0; step <= steps; step += 1) {
        const t = (step / steps) * length;
        const x = a.x + (dx / length) * t;
        const z = a.z + (dz / length) * t;
        const key = `${Math.round(x / JUNCTION_CELL)}:${Math.round(z / JUNCTION_CELL)}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { sumX: 0, sumZ: 0, count: 0, axes: new Map(), majors: 0 };
          cells.set(key, cell);
        }
        cell.sumX += x;
        cell.sumZ += z;
        cell.count += 1;
        if (cell.axes.has(road.id)) continue;
        cell.axes.set(road.id, { yaw, width: road.width, major: family === 'major' });
        if (family === 'major') cell.majors += 1;
      }
    }
  }

  // Busiest first, and "busy" now leads with how many main roads meet here rather than
  // how many roads of any kind do: with a limit on how many junctions get lights, the
  // ones that keep them should be the big crossings, not a cluster of back lanes that
  // happen to converge.
  const candidates = [...cells.values()]
    .filter((cell) => cell.axes.size >= 2 && cell.majors >= 1)
    .sort((a, b) => (b.majors - a.majors) || (b.axes.size - a.axes.size) || (b.count - a.count));

  const signals: TrafficSignal[] = [];
  const placed: Array<{ x: number; z: number }> = [];
  const spacingSq = MIN_JUNCTION_SPACING * MIN_JUNCTION_SPACING;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    if (candidateIndex > 0 && candidateIndex % SIGNAL_CHUNK === 0) yield;
    const cell = candidates[candidateIndex];
    if (signals.length + 4 > limit) break;
    const x = cell.sumX / cell.count;
    const z = cell.sumZ / cell.count;
    if (placed.some((site) => (site.x - x) ** 2 + (site.z - z) ** 2 < spacingSq)) continue;

    // Two crossing axes make the two phases. A cell whose roads all run the same way is
    // a road splitting or a pair of parallel carriageways, not a junction.
    //
    // The main road is always the primary, and the crossing arm has to be substantial in
    // its own right — another major, or at least a full two-lane carriageway. Both are
    // taken widest-first so a junction where a main road meets several side streets is
    // signalled across the biggest of them rather than whichever the data listed first.
    const axes = [...cell.axes.values()].sort((a, b) => b.width - a.width);
    const primary = axes.find((axis) => axis.major);
    if (primary == null) continue;
    const secondary = axes.find((axis) => (
      axis !== primary
      && (axis.major || axis.width >= BIG_JUNCTION_CROSS_WIDTH)
      && axisSeparation(axis.yaw, primary.yaw) >= MIN_AXIS_SEPARATION
    ));
    if (secondary == null) continue;

    const offsetSeconds = positionSeed(x, z) * SIGNAL_CYCLE_SECONDS;
    const heads: TrafficSignal[] = [];
    for (const [group, axis] of [[0, primary], [1, secondary]] as const) {
      const sideOffset = axis.width / 2 + ARM_SIDE_CLEARANCE;
      // Both directions of travel along the axis, each with its own head.
      for (const facing of [axis.yaw, axis.yaw + Math.PI]) {
        const dirX = Math.sin(facing);
        const dirZ = Math.cos(facing);
        heads.push({
          // Back from the centre along the approach, and out past its own paved edge.
          x: x - dirX * ARM_SETBACK + dirZ * sideOffset,
          z: z - dirZ * ARM_SETBACK - dirX * sideOffset,
          // Facing back at the traffic it stops, which is the reverse of its approach.
          yaw: Math.atan2(-dirX, -dirZ),
          group,
          offsetSeconds,
        });
      }
    }
    // A multi-way junction or a road curving through the cell can still put a head back
    // on pavement even with a width-aware offset; skip the whole junction rather than
    // draw a partial set — it just reads as one of the many real junctions with no
    // lights, not as broken geometry.
    if (heads.some((head) => isPointOnAnyRoad(head.x, head.z, roads, 0))) continue;

    placed.push({ x, z });
    signals.push(...heads);
  }
  return signals;
}

/** The all-at-once form, for callers with no frame to protect. Drains the generator, so a
 * sliced build and an eager one cannot signal different junctions. */
export function findTrafficSignals(roads: WorldRoad[], limit: number): TrafficSignal[] {
  const job = findTrafficSignalsJob(roads, limit);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}


/** Where a route crosses a signalised approach, and how far along the route that is. */
export interface RouteSignalStop {
  traveledMeters: number;
  signal: TrafficSignal;
}

/** How close a signal head must sit to a route leg, and how closely that leg's heading
 * must line up with the approach the head controls, to count as "this route passes
 * through this signal". The axis tolerance is comfortably under MIN_AXIS_SEPARATION, so
 * it can never accidentally match the crossing street's head instead of this one's — the
 * two are at least that far apart by construction. */
const ROUTE_SIGNAL_TOLERANCE = 12;
const ROUTE_SIGNAL_AXIS_TOLERANCE = 0.4;

function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/**
 * Every point along `path` where it passes a signal head facing the direction of
 * travel there, in the order the route reaches them. A head only matches the leg whose
 * heading it actually faces — the opposing head on the same physical approach faces the
 * other way and simply never lines up with any leg of a route travelling this direction,
 * so there is no risk of matching the wrong one of a pair that shares a position.
 */
export function findRouteSignalStops(path: LocalPoint[], signals: TrafficSignal[]): RouteSignalStop[] {
  if (path.length < 2 || !signals.length) return [];
  const stops: RouteSignalStop[] = [];
  const matched = new Set<TrafficSignal>();
  let cumulative = 0;
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const legLength = Math.hypot(dx, dz);
    if (legLength > 0) {
      const heading = Math.atan2(dx, dz);
      for (const head of signals) {
        if (matched.has(head)) continue;
        // A head faces back at the traffic it stops (see TrafficSignal.yaw), so the
        // approach it controls runs the reverse of where the head itself points.
        const approachHeading = wrapAngle(head.yaw + Math.PI);
        if (Math.abs(wrapAngle(approachHeading - heading)) > ROUTE_SIGNAL_AXIS_TOLERANCE) continue;
        const t = Math.min(1, Math.max(0, ((head.x - from.x) * dx + (head.z - from.z) * dz) / (legLength * legLength)));
        const px = from.x + dx * t;
        const pz = from.z + dz * t;
        const distanceSq = (head.x - px) ** 2 + (head.z - pz) ** 2;
        if (distanceSq > ROUTE_SIGNAL_TOLERANCE ** 2) continue;
        matched.add(head);
        stops.push({ traveledMeters: cumulative + t * legLength, signal: head });
      }
    }
    cumulative += legLength;
  }
  return stops.sort((a, b) => a.traveledMeters - b.traveledMeters);
}

/**
 * The nearest ahead-of-`traveledMeters` stop that isn't currently green, or null if
 * everything ahead is clear. Stops still green are skipped rather than stopping the
 * search, so a green junction followed by a red one correctly blocks on the red one.
 */
export function nextBlockingSignalStop(
  stops: RouteSignalStop[],
  traveledMeters: number,
  timeSeconds: number,
): RouteSignalStop | null {
  for (const stop of stops) {
    if (stop.traveledMeters < traveledMeters - 0.5) continue;
    if (resolveSignalAspect(stop.signal, timeSeconds) === 'green') continue;
    return stop;
  }
  return null;
}

/** A built batch of signals plus the one call that drives them. */
export interface TrafficLightBatch {
  group: THREE.Group;
  /** Repaints only the heads whose aspect actually changed since the last call, so the
   * steady state costs one comparison per head and no GPU traffic at all. */
  update(timeSeconds: number): void;
}

const POLE_HEIGHT = 3.6;
const HOUSING_Y = 3.15;
/** Lamp centres, top to bottom. */
const LAMP_HEIGHTS = [3.62, 3.24, 2.86] as const;
const ASPECT_ORDER: readonly SignalAspect[] = ['red', 'amber', 'green'];
const LIT_COLORS = [0xff2d1c, 0xffab1f, 0x2bff62] as const;
/** An unlit lens is not black — it is a dark, slightly coloured piece of glass, and
 * painting it black makes a signal head read as having only one lamp. */
const DARK_COLORS = [0x2a0d0a, 0x2a1d08, 0x0a2a14] as const;

export function createTrafficLights(signals: TrafficSignal[]): TrafficLightBatch {
  const group = new THREE.Group();
  group.name = 'world:traffic-lights';
  if (!signals.length) return { group, update: () => {} };

  const poleGeometry = new THREE.CylinderGeometry(0.07, 0.1, POLE_HEIGHT, 6);
  poleGeometry.translate(0, POLE_HEIGHT / 2, 0);
  const metal = new THREE.MeshStandardMaterial({ color: 0x23272a, roughness: 0.55, metalness: 0.4 });
  const poles = new THREE.InstancedMesh(poleGeometry, metal, signals.length);
  poles.name = 'world:traffic-lights:poles';
  poles.castShadow = true;
  poles.receiveShadow = true;

  const housings = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 1.15, 0.3), metal, signals.length);
  housings.name = 'world:traffic-lights:housings';
  housings.castShadow = true;
  housings.receiveShadow = true;

  // One mesh per lens position rather than per colour, so a head's three lenses are
  // three fixed instances and switching aspect is a colour write, never a rebuild.
  const lensGeometry = new THREE.SphereGeometry(0.115, 8, 6);
  const lenses = ASPECT_ORDER.map((aspect) => {
    const mesh = new THREE.InstancedMesh(
      lensGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      signals.length,
    );
    mesh.name = `world:traffic-lights:${aspect}`;
    // A lens is a light source, not a shadow caster; and at 11cm it would contribute
    // nothing to the shadow map but cost.
    mesh.castShadow = false;
    return mesh;
  });

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  signals.forEach((signal, index) => {
    // Every part is measured up from the surface the mast stands on, not from y=0. A
    // signal at a junction inside a landuse mound used to be planted at the ground plane
    // and stand knee-deep in the bank around it.
    const base = signal.y ?? 0;
    matrix.makeRotationY(signal.yaw);
    matrix.setPosition(signal.x, base, signal.z);
    poles.setMatrixAt(index, matrix);
    matrix.setPosition(signal.x, base + HOUSING_Y, signal.z);
    housings.setMatrixAt(index, matrix);
    // The lens sits proud of the housing on the face the driver sees.
    const outX = Math.sin(signal.yaw) * 0.19;
    const outZ = Math.cos(signal.yaw) * 0.19;
    LAMP_HEIGHTS.forEach((y, lamp) => {
      matrix.makeRotationY(signal.yaw);
      matrix.setPosition(signal.x + outX, base + y, signal.z + outZ);
      lenses[lamp].setMatrixAt(index, matrix);
      lenses[lamp].setColorAt(index, color.setHex(DARK_COLORS[lamp]));
    });
  });
  poles.instanceMatrix.needsUpdate = true;
  housings.instanceMatrix.needsUpdate = true;
  for (const mesh of lenses) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  const records = signals.map((signal, index) => ({
    id: `runtime:traffic-signal:${index}:${signal.x.toFixed(1)}:${signal.z.toFixed(1)}`,
    category: 'object',
    title: 'Traffic signal',
    source: 'runtime',
    properties: { kind: 'traffic_signals', phase: signal.group === 0 ? 'A' : 'B' },
  } satisfies WorldInspectionRecord));
  poles.userData[INSPECTION_USER_DATA_KEY] = records;
  housings.userData[INSPECTION_USER_DATA_KEY] = records;

  group.add(poles, housings, ...lenses);

  // 255 marks "never painted", so the first update always writes every head.
  const shown = new Uint8Array(signals.length).fill(255);
  return {
    group,
    update(timeSeconds: number) {
      let touched = false;
      for (let index = 0; index < signals.length; index += 1) {
        const aspect = ASPECT_ORDER.indexOf(resolveSignalAspect(signals[index], timeSeconds));
        if (shown[index] === aspect) continue;
        shown[index] = aspect;
        touched = true;
        for (let lamp = 0; lamp < lenses.length; lamp += 1) {
          lenses[lamp].setColorAt(index, color.setHex(lamp === aspect ? LIT_COLORS[lamp] : DARK_COLORS[lamp]));
        }
      }
      if (!touched) return;
      for (const mesh of lenses) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}
