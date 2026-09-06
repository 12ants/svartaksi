/**
 * Procedurally places lamp posts along road centerlines — independent of whatever
 * street-lamp nodes a data source happens to map — so every street reads as lit
 * instead of only the rare OSM way that was manually tagged `highway=street_lamp`.
 * Pure geometry in, placements out; threeWorld turns placements into instanced meshes.
 */
import { getRoadFamily } from '../svartaksi/roadStyle';
import { isPavementClear } from './roadClearance';
import type { WorldBuilding, WorldRoad } from './types';

export interface LampPlacement {
  x: number;
  z: number;
  /** Height of the surface the post stands on: the terrain under it, or the deck it is
   * bolted to. Posts used to be planted at y=0 regardless, which left every lamp beside a
   * bridge hanging in mid-air next to a deck several meters above it. */
  y: number;
  /** Yaw (radians) of the road segment the lamp sits beside, for orienting its pole. */
  yaw: number;
  /** True where the post stands *on* a road deck rather than on the ground beside the
   * road — it is set inboard of the paved edge, inside the parapet, because there is no
   * verge out there to plant it in. */
  onDeck: boolean;
}

/**
 * What the placement walk needs to know about the surfaces under it. Both are optional:
 * without them lamps fall back to standing at y=0 beside the road, which is what they did
 * before decks existed and is still right for a preview grid or a fixture with no terrain.
 */
export interface LampSurface {
  /** Ground height beside the road — the landuse extrusion under this point. */
  groundHeightAt?: (x: number, z: number) => number;
  /**
   * Surface height of *this* road at `distanceAlong` meters from its own start, or null
   * where the road has no elevation profile at all — which is the overwhelming majority
   * of them, and means "at grade, wherever the terrain is".
   *
   * Keyed to the road being walked rather than to a point in space on purpose. A point
   * query answers with the highest deck covering it, so a lamp planted beside the street
   * that runs *under* a viaduct would have been handed the viaduct's height and hoisted
   * onto a deck it has nothing to do with.
   */
  deckHeightAlong?: (road: WorldRoad, distanceAlong: number) => number | null;
}

/** Meters between consecutive posts along one side of a qualifying road. Real streets
 * are lit more sparsely than a dense downtown grid's lamp count once suggested. */
export const LAMP_SPACING = 45;
/** Clearance beyond the road's paved edge before planting a post. */
const LAMP_SETBACK = 1.4;

/**
 * How far the road surface has to stand over the ground beside it before a lamp is treated
 * as a deck lamp. Matches `ROAD_DECK_LIFT`'s own reasoning — a landuse mound tops out
 * around 1.2m, so anything past this is a structure, not a road riding over a park border.
 */
const DECK_LAMP_MIN_LIFT = 1.5;

/**
 * Meters in from the paved edge a deck lamp stands. Just inboard of the railing line
 * (`bridgeRailings.ts`'s RAILING_INSET, 0.3m) so the post stands against the parapet
 * rather than inside it — and no further, because every extra centimetre is taken out of
 * the running lane a deck has no verge to spare beside.
 */
const LAMP_DECK_INSET = 0.7;

/**
 * Walks each road's polyline and drops a lamp every LAMP_SPACING meters, alternating
 * sides so the street reads as evenly lit rather than one-sided. Footways/cycleways
 * are skipped — pedestrian paths get ambiance from nearby street lighting instead of
 * their own posts, keeping density sane in parks and along riverside trails.
 *
 * Where the road at that point is a deck, the post moves *inboard* of the paved edge and
 * stands on the deck itself. Outboard is where a lamp belongs on a street and is thin air
 * on a bridge; and the pavement-occupancy check that keeps a street lamp off the
 * carriageway is exactly wrong there, since the deck is the only ground the post has.
 */
/**
 * Roads per yield.
 *
 * The placement walk is the same shape as the road-elevation builder's emit loop, so it
 * takes the same chunk size and for the same reason: a few hundred roads is a fraction of
 * a millisecond, well inside the 4ms build budget, while still being coarse enough that
 * the generator machinery costs nothing next to the work it interrupts.
 */
const LAMP_ROAD_CHUNK = 256;

/**
 * The incremental form, which is the real implementation.
 *
 * Placing lamps was one of three stages that ran whole between two of the world builder's
 * yields, and between them they are why build slices overran the frame budget by up to
 * eleven times. The question that had to be answered before it could be cut up was
 * whether the spacing and dedupe logic needs to see the whole input at once. It does not:
 * `sinceLast`, `side` and `alongRoad` are all reset per road, so nothing accumulates
 * across the outer loop, and the one whole-network query — `isPavementClear`, which reads
 * every road and every building — is read-only and unaffected by where the walk pauses.
 *
 * So the loop can yield at any road boundary, and it emits in exactly the order it did
 * before. That matters more than it looks: the caller keeps the first N lamps within its
 * budget, so a change of order would silently change which lamps survive.
 */
export function* generateStreetLightsJob(
  roads: WorldRoad[],
  buildings: WorldBuilding[] = [],
  surface: LampSurface = {},
): Generator<void, LampPlacement[], void> {
  const lights: LampPlacement[] = [];
  const groundAt = surface.groundHeightAt ?? (() => 0);
  const deckAt = surface.deckHeightAlong ?? (() => null);
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
    if (roadIndex > 0 && roadIndex % LAMP_ROAD_CHUNK === 0) yield;
    const road = roads[roadIndex];
    if (getRoadFamily(road.kind) === 'path') continue;
    if (road.points.length < 2) continue;
    const half = road.width / 2;
    const offset = half + LAMP_SETBACK;
    // Never past the centreline, however narrow the carriageway is — a deck lamp planted
    // in the middle of a single-lane bridge would be an obstacle rather than a verge post.
    const deckOffset = Math.max(half * 0.5, half - LAMP_DECK_INSET);
    let sinceLast = LAMP_SPACING;
    let side = 1;
    /** Distance from the road's first point to the start of the segment being walked —
     * the frame `deckHeightAlong` (and the profile behind it) is expressed in. */
    let alongRoad = 0;
    for (let index = 0; index < road.points.length - 1; index += 1) {
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
      while (sinceLast + (segmentLength - traveled) >= LAMP_SPACING) {
        traveled += LAMP_SPACING - sinceLast;
        const centerX = a.x + dirX * traveled;
        const centerZ = a.z + dirZ * traveled;
        const ground = groundAt(centerX, centerZ);
        const deck = deckAt(road, alongRoad + traveled);
        const onDeck = deck !== null && deck - ground > DECK_LAMP_MIN_LIFT;
        const reach = onDeck ? deckOffset : offset;
        const x = centerX + normalX * reach * side;
        const z = centerZ + normalZ * reach * side;
        const yaw = Math.atan2(dirX, dirZ);
        if (onDeck) {
          // The deck carries no cross-fall in geometry, so its height at the post is its
          // height on the centreline — no second query needed to move off it.
          lights.push({ x, z, y: deck as number, yaw, onDeck: true });
        } else if (isPavementClear(x, z, roads, 0, buildings)) {
          // The per-road setback keeps a post off *this* road; a bend or a second road
          // running close alongside can still put that point back on pavement, and a
          // building whose footprint reaches the kerb can too — every candidate is
          // checked against the whole network and every building before it is kept.
          lights.push({ x, z, y: groundAt(x, z), yaw, onDeck: false });
        }
        side = -side;
        sinceLast = 0;
      }
      sinceLast += segmentLength - traveled;
      alongRoad += segmentLength;
    }
  }
  return lights;
}

/**
 * The all-at-once form, for callers with no frame to protect (tests, tools, fixtures).
 *
 * Drains the generator rather than duplicating it, so a sliced build and an eager one
 * cannot produce different lamps.
 */
export function generateStreetLights(
  roads: WorldRoad[],
  buildings: WorldBuilding[] = [],
  surface: LampSurface = {},
): LampPlacement[] {
  const job = generateStreetLightsJob(roads, buildings, surface);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
