/**
 * Procedurally places bus shelters along the road network, the same way streetLights
 * places lamp posts: OSM's `highway=bus_stop` nodes are sparse and inconsistently
 * mapped, so waiting for them leaves whole districts with no transit furniture at all
 * while the bus drives through them.
 *
 * Pure geometry in, placements out; threeWorld turns placements into instanced meshes.
 */
import { isPavementClear } from './roadClearance';
import type { WorldBuilding, WorldRoad } from './types';

export interface BusStopPlacement {
  x: number;
  z: number;
  /** Height of the surface the shelter stands on. Optional because generation is about
   * *where on the map* a shelter goes, not how high the ground is there — `standOnGround`
   * (threeWorld.ts) fills it in from the shared surface datum afterwards. Absent means the
   * ground plane, which is what a fixture or a preview grid wants. */
  y?: number;
  /** Yaw (radians) of the road segment, so the shelter's open side faces the kerb. */
  yaw: number;
}

/** Road kinds a bus route is served on. Deliberately *not* `getRoadFamily(kind) ===
 * 'major'`: that set includes motorway and trunk, and a glass shelter standing on a
 * motorway shoulder is the kind of detail that reads as a bug. Tertiary is in, even
 * though the style layer calls it minor, because that is where half of a suburb's bus
 * network actually runs. */
const BUS_ROUTE_KINDS = new Set(['primary', 'secondary', 'tertiary']);

/** Meters between shelters along one road. Far sparser than LAMP_SPACING: a shelter is
 * a landmark, and one every block reads as a tram museum rather than a bus route. */
export const BUS_STOP_SPACING = 320;
/** Clearance beyond the paved edge before the *center* of a shelter — it is 1.7m deep,
 * so this has to clear half of that plus a pavement's worth of standing room. */
const BUS_STOP_SETBACK = 3.2;
/** Shorter roads than this never get a stop: a 40m residential stub with a shelter on
 * it looks like scenery dropped at random rather than a served route. */
const MIN_ROAD_LENGTH = 120;

/**
 * Loop iterations per yield.
 *
 * The same 256 the lamp and tree walks already use, and for the same reason: coarse
 * enough that the generator machinery costs nothing next to the work it interrupts, fine
 * enough that a slice stays well inside the 4ms build budget. Counted over *all* the
 * inner loops rather than roads, because a single 4km primary road is one road and
 * hundreds of candidate positions — pacing per road would leave exactly the overrun this
 * is meant to remove.
 */
const BUS_STOP_OP_CHUNK = 256;

/**
 * Walks each qualifying road and drops a shelter every BUS_STOP_SPACING meters,
 * alternating sides so both directions of travel are served. Only BUS_ROUTE_KINDS are
 * considered — buses run on through-routes, not on footways or residential loops — and
 * the first stop is offset half a spacing in so shelters don't cluster at junctions
 * where every way in a corridor starts.
 */
export function* generateBusStopsJob(
  roads: WorldRoad[],
  buildings: WorldBuilding[] = [],
): Generator<void, BusStopPlacement[], void> {
  const stops: BusStopPlacement[] = [];
  // Nothing accumulates across a pause: `sinceLast` and `side` reset per road, the one
  // whole-network query (`isPavementClear`) is read-only, and `stops` is only appended
  // to. So the walk emits the same shelters in the same order wherever it stops, which
  // matters because the caller keeps the first MAX_BUS_STOPS of them.
  let operations = 0;
  for (const road of roads) {
    if (++operations % BUS_STOP_OP_CHUNK === 0) yield;
    if (!BUS_ROUTE_KINDS.has(road.kind)) continue;
    if (road.points.length < 2) continue;
    let length = 0;
    for (let index = 0; index < road.points.length - 1; index += 1) {
      if (++operations % BUS_STOP_OP_CHUNK === 0) yield;
      const a = road.points[index];
      const b = road.points[index + 1];
      length += Math.hypot(b.x - a.x, b.z - a.z);
    }
    if (length < MIN_ROAD_LENGTH) continue;
    const offset = road.width / 2 + BUS_STOP_SETBACK;
    let sinceLast = BUS_STOP_SPACING / 2;
    let side = 1;
    for (let index = 0; index < road.points.length - 1; index += 1) {
      if (++operations % BUS_STOP_OP_CHUNK === 0) yield;
      const a = road.points[index];
      const b = road.points[index + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segmentLength = Math.hypot(dx, dz);
      if (segmentLength < 1e-6) continue;
      const dirX = dx / segmentLength;
      const dirZ = dz / segmentLength;
      const normalX = -dirZ;
      const normalZ = dirX;
      let traveled = 0;
      while (sinceLast + (segmentLength - traveled) >= BUS_STOP_SPACING) {
        if (++operations % BUS_STOP_OP_CHUNK === 0) yield;
        traveled += BUS_STOP_SPACING - sinceLast;
        const x = a.x + dirX * traveled + normalX * offset * side;
        const z = a.z + dirZ * traveled + normalZ * offset * side;
        // A shelter is a solid box, not a 10cm post: a bend or a road running close
        // alongside can put this point back on pavement, a building's own footprint can
        // too, and a bus driving through its own stop is far more obvious than a lamp
        // post in the gutter. The extra margin clears the shelter's own depth rather
        // than just its centre.
        if (isPavementClear(x, z, roads, BUS_STOP_SETBACK * 0.5, buildings)) {
          // Yaw is the direction the shelter's open side (local +Z) faces: back to the
          // pavement, opening onto the kerb, which is the inward normal for whichever
          // side of the centreline it stands on.
          stops.push({ x, z, yaw: Math.atan2(dirZ * side, -dirX * side) });
        }
        side = -side;
        sinceLast = 0;
      }
      sinceLast += segmentLength - traveled;
    }
  }
  return stops;
}

/**
 * The all-at-once form, for callers with no frame to protect (tests, tools, fixtures).
 *
 * Drains the generator rather than duplicating it, so a sliced build and an eager one
 * cannot place different shelters.
 */
export function generateBusStops(roads: WorldRoad[], buildings: WorldBuilding[] = []): BusStopPlacement[] {
  const job = generateBusStopsJob(roads, buildings);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
