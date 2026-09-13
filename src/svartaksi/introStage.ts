/**
 * The world the opening cinematic happens in.
 *
 * The intro is set on a forest road at dusk, and no such road exists at START_LOCATION —
 * Gärdet is open city. Rather than stream somewhere else (a network round trip before the
 * player has seen a single frame, which is exactly what sank the previous scripted
 * opening — see the OPENING_RIDE note in config.ts), the stage is *synthesized*: a
 * `WorldData` built in code and handed to the same renderer, vegetation scatterer and
 * collider pipeline every streamed tile goes through.
 *
 * That is the whole trick, and it is why this module is small. `WorldData` is plain data
 * (`world/types.ts`), so a road here is the same kind of thing as a road from OSM: the
 * ribbon renderer draws it, `terrain.ts` lifts the forest polygons it sits between, and
 * `busRouting.ts` drives a bus down it — none of them can tell the difference, and none
 * of them needed changing.
 *
 * Everything is authored in local metres, the coordinate system `world/geo.ts` puts every
 * other module in. The stage is placed well away from the origin so it cannot overlap
 * anything the real world will later stream in around Gärdet.
 */
import { BUS_DIMENSIONS } from './busGeometry';
import type { LocalPoint, WorldArea, WorldData, WorldRoad } from '../world/types';

/**
 * Radius of every bend in the weave, in metres.
 *
 * This is not a styling choice, it is the shot's pace. `buildRideProfile` turns a corner's
 * geometry into a speed with `v = sqrt(BUS_LATERAL_ACCEL * r)`, so the radius *is* how
 * fast the bus takes scene 2: 65m gives sqrt(1.3 * 65) = 9.2 m/s, a touch under the 12.5
 * m/s it holds on the straights. That drop is wanted — a bus easing off into a dark bend
 * is the shot — but it must not become a crawl, and it must stay well clear of
 * BUS_DIMENSIONS.minTurnRadius (9.5m), below which the route is flagged infeasible and the
 * bus visibly clips the corner.
 */
const WEAVE_RADIUS = 65;

/**
 * How far the road swings off its axis at each bend, in radians.
 *
 * Chosen for what the camera sees rather than for the map: at 0.5 rad (29°) the road
 * leaves frame around the bend ahead instead of running to the horizon, which is what
 * makes scene 2 read as snaking. Larger would be more dramatic and slower — arc length
 * grows with it, and scene 2 has a fixed duration to fill.
 */
const WEAVE_SWEEP = 0.5;

/**
 * Distance between sampled points along the road, in metres.
 *
 * A corner's radius is recovered from the polyline by `buildRideProfile`, which fits the
 * largest arc between two legs — so sampling density is what tells it a bend is a bend and
 * not a kink. At 4m steps a WEAVE_RADIUS bend resolves to within a few percent of its true
 * radius; much coarser and the fit reads tighter than the road really is and slows the bus
 * for a corner that is not there.
 */
const ROAD_STEP = 4;

/** Heading that points along −x. The bus drives this way so that a camera standing on the
 * +z side of the road sees it enter from the right of frame and leave to the left — see
 * `INTRO_SHOTS`' scene 1, which is specified in those terms. */
const WESTBOUND = -Math.PI / 2;

/** Where the road begins, far enough east that the bus is off camera when scene 1 opens. */
const ROAD_START: LocalPoint = { x: 2_230, z: 2_000 };

/** One piece of the road: hold a constant curvature (1/r, signed; 0 is straight) for a
 * given arc length. A road is a list of these, which is the smallest description that can
 * state a bend's radius directly — the one number the bus's speed depends on. */
interface RoadSegment {
  /** Signed curvature, 1/metres. Positive bends toward +z. */
  curvature: number;
  /** Arc length, metres. */
  meters: number;
}

/** A bend of `WEAVE_RADIUS` sweeping `radians`, bending toward +z when `sign` is 1. */
function bend(sign: 1 | -1, radians: number): RoadSegment {
  return { curvature: sign / WEAVE_RADIUS, meters: WEAVE_RADIUS * radians };
}

/**
 * The road, as a sequence of constant-curvature segments.
 *
 * The lengths are the scene durations translated into distance, which is why they look
 * arbitrary: at 12.5 m/s the opening straight is scene 1's eight seconds, and the weave is
 * scene 2's sixteen at the 9.2 m/s its radius allows. The shot durations in
 * introSequence.ts are the other half of this and have to be kept in step with it — the
 * test measures the real profile rather than trusting either.
 *
 * The weave is a single bend and counter-bend that returns the road to its original
 * heading: +0.5 rad, −1.0 rad, +0.5 rad. It leaves the road laterally offset from where it
 * started, which is what a real road does and what keeps the far end out of shot.
 */
const ROAD_SEGMENTS: RoadSegment[] = [
  { curvature: 0, meters: 130 },
  bend(1, WEAVE_SWEEP),
  bend(-1, WEAVE_SWEEP * 2),
  bend(1, WEAVE_SWEEP),
  // The run-out. `buildRideProfile` pins the last vertex to a standstill and brakes back
  // from it at BUS_BRAKE, so the final ~31m of any path is a stop the bus is already
  // slowing for. Scene 3 must not be watching that, so the road runs on well past where
  // the cinematic ends.
  { curvature: 0, meters: 260 },
];

/**
 * Walks the segment list into a polyline.
 *
 * Headings follow the codebase convention (`cameraRig.ts`): forward is
 * `(sin h, 0, cos h)`, so a positive turn rate swings the road toward +z. Integrating at a
 * fixed step rather than solving each arc in closed form keeps the sampling uniform across
 * straights and bends, which is what ROAD_STEP's radius-recovery argument assumes.
 */
function traceRoad(start: LocalPoint, heading: number, segments: RoadSegment[]): LocalPoint[] {
  const points: LocalPoint[] = [{ ...start }];
  let x = start.x;
  let z = start.z;
  let h = heading;
  for (const segment of segments) {
    const steps = Math.max(1, Math.round(segment.meters / ROAD_STEP));
    const step = segment.meters / steps;
    for (let i = 0; i < steps; i += 1) {
      // Midpoint heading over the step, so a bend's chord does not systematically fall
      // inside the arc it is meant to approximate.
      const midHeading = h + (segment.curvature * step) / 2;
      x += Math.sin(midHeading) * step;
      z += Math.cos(midHeading) * step;
      h += segment.curvature * step;
      points.push({ x, z });
    }
  }
  return points;
}

/** The centreline the bus drives, and the road the player sees it drive on: one polyline,
 * so the two cannot disagree. Built once per module load rather than per call — it is a
 * constant, and `sampleRide` is handed it every frame. */
export const INTRO_ROAD_PATH: LocalPoint[] = traceRoad(ROAD_START, WESTBOUND, ROAD_SEGMENTS);

/** Total centreline length in metres, for the sequence module's budget assertions. */
export const INTRO_ROAD_LENGTH = ROAD_SEGMENTS.reduce((total, segment) => total + segment.meters, 0);

/**
 * How far the forest is held back from the centreline, in metres.
 *
 * Wide enough that the road has a verge and the bus's headlights have somewhere to fall
 * before the treeline catches them, narrow enough that the trees still crowd the frame.
 * The trees themselves are not placed here: `threeWorld.ts` scatters them from any park
 * area whose kind has a density in `vegetation.ts`'s SPECIES table, and `forest` has the
 * densest. Authoring the polygon is the whole job.
 */
const VERGE = 11;

/** How deep the forest runs behind the verge, in metres. Only the first few rows read at
 * night, but the band has to outlast the headlights' throw or the world ends visibly. */
const FOREST_DEPTH = 150;

/** Builds the forest as two bands, one either side of the road, each following the
 * centreline out at `VERGE` and back at `VERGE + FOREST_DEPTH`. Offsetting the real
 * polyline rather than drawing a rectangle is what keeps the verge parallel through the
 * bends — a rectangle would let the treeline cut across the road at each corner. */
function forestBand(path: LocalPoint[], side: 1 | -1): WorldArea {
  const inner: LocalPoint[] = [];
  const outer: LocalPoint[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const previous = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const span = Math.hypot(dx, dz) || 1;
    // Left-hand normal of the direction of travel, scaled by which side we are building.
    const nx = (-dz / span) * side;
    const nz = (dx / span) * side;
    inner.push({ x: path[i].x + nx * VERGE, z: path[i].z + nz * VERGE });
    outer.push({ x: path[i].x + nx * (VERGE + FOREST_DEPTH), z: path[i].z + nz * (VERGE + FOREST_DEPTH) });
  }
  // Out along the inner edge, back along the outer: one simple closed ring.
  const ring = inner.concat(outer.reverse());
  ring.push({ ...ring[0] });
  return { id: `intro:forest:${side > 0 ? 'north' : 'south'}`, kind: 'forest', rings: [ring] };
}

/**
 * The intro stage as a `WorldData`, ready to hand to the runtime's `adoptWorldData`.
 *
 * No buildings and no water: this is a road through a wood, and both lists being empty is
 * the statement that there is nothing else out there. Note that `resolveWorldData`'s
 * "insufficient map data" guard does not apply here — that guard exists to catch a
 * provider returning an empty tile, and this data is authored, not fetched.
 */
export function buildIntroStage(): WorldData {
  const road: WorldRoad = {
    id: 'intro:road',
    // A country road through forest: two lanes, no markings to speak of, which is what
    // `unclassified` draws as. Its width is set here rather than left to the style
    // default so the shot framing does not move if that default is ever retuned.
    kind: 'unclassified',
    width: 6.5,
    points: INTRO_ROAD_PATH,
    structure: 'ground',
    layer: 0,
  };
  return {
    source: 'maplibre',
    roads: [road],
    buildings: [],
    water: [],
    parks: [forestBand(INTRO_ROAD_PATH, 1), forestBand(INTRO_ROAD_PATH, -1)],
    labels: [],
    objects: [],
  };
}

/** Re-exported so the sequence module and its tests can reason about the bus's footprint
 * (when it is clear of frame, where its wheels sit) without importing the geometry sheet
 * separately. */
export const INTRO_BUS_HALF_LENGTH = BUS_DIMENSIONS.length / 2;
