/**
 * The one `RoadElevationProfile` builder: sampled per-road heights derived from
 * normalized `structure`/`layer` semantics, crossing resolution, and terrain
 * clearance, with slope-limited approach ramps. Rendering (`threeWorld.ts`) and
 * physics (`svartaksiRuntime.tsx`'s ground-height callback) both read the same profile
 * instead of keeping independent copies — see backlog item 8.
 *
 * `layer` is ordering evidence, not a height in meters (backlog item 8's own framing):
 * it only ever decides *which* of two crossing roads is resolved above the other. The
 * actual clearance in meters is a constant this module owns (`CROSSING_VERTICAL_CLEARANCE`),
 * applied on top of whichever baseline (terrain-cleared) height the lower road already has.
 */
import { roadRibbonFrames, extendRoadEndpoints } from './roadRibbon';
import { createSpatialGrid, type SpatialGrid } from './spatialGrid';
import { buildTerrainIndex, terrainHeightAtIndexed, type TerrainClearance, type TerrainIndex } from './terrain';
import type { LocalPoint, RoadStructure, WorldRoad } from './types';

export interface RoadStructureInfo {
  structure: RoadStructure;
  layer: number;
}

/** Bridge outranks ground/ford, which outrank tunnel — a bridge is always drawn above
 * whatever it crosses, a tunnel always below, and plain roads sort by `layer` only when
 * they tie on structure. */
const STRUCTURE_RANK: Record<RoadStructure, number> = { tunnel: 0, ground: 1, ford: 1, bridge: 2 };

/**
 * Reads a road's normalized `structure`/`layer` off its own typed fields — the
 * provider boundary (see `maplibreProvider.ts`) is what turns raw `brunnel`/`bridge`/
 * `tunnel`/`layer` tags into these two fields, once, so every consumer downstream reads
 * the same explicit state rather than re-parsing tags.
 */
export function structureInfo(road: Pick<WorldRoad, 'structure' | 'layer'>): RoadStructureInfo {
  return { structure: road.structure ?? 'ground', layer: Number.isFinite(road.layer) ? (road.layer as number) : 0 };
}

/**
 * Normalizes a raw OSM/vector-tile property bag into `{ structure, layer }` — the
 * minimal slice of backlog item 5's OSM semantic model this item actually depends on.
 * `brunnel` (OpenMapTiles' own bridge/tunnel/ford enum) wins when present; otherwise
 * falls back to boolean `bridge`/`tunnel`/`ford` tags. Unknown/missing tags default to
 * `'ground'` at `layer` 0 — a conservative default, never a guessed structure.
 */
export function normalizeRoadStructure(properties: Record<string, unknown> | undefined): RoadStructureInfo {
  const props = properties ?? {};
  const layerRaw = Number(props.layer);
  const layer = Number.isFinite(layerRaw) ? layerRaw : 0;
  const brunnel = String(props.brunnel ?? '').toLowerCase();
  if (brunnel === 'bridge' || String(props.bridge ?? '').toLowerCase() === 'yes') return { structure: 'bridge', layer };
  if (brunnel === 'tunnel' || String(props.tunnel ?? '').toLowerCase() === 'yes') return { structure: 'tunnel', layer };
  if (brunnel === 'ford' || String(props.ford ?? '').toLowerCase() === 'yes') return { structure: 'ford', layer };
  return { structure: 'ground', layer };
}

export interface RoadCrossing {
  roadId: string;
  otherRoadId: string;
  point: LocalPoint;
  /** Distance in meters along `roadId` from its first point to the crossing. */
  distanceAlong: number;
  /** Distance in meters along `otherRoadId`. */
  otherDistanceAlong: number;
  /** Which side resolves above the other, or 'unresolved' when structure and layer both
   * tie — surfaced for debug inspection rather than silently guessed. */
  resolution: 'road' | 'other' | 'unresolved';
}

function cumulativeDistances(points: LocalPoint[]): number[] {
  const out = [0];
  for (let index = 1; index < points.length; index += 1) {
    out.push(out[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z));
  }
  return out;
}

/** Standard parametric segment/segment intersection; null when parallel or the
 * crossing falls outside either segment's own span. */
function segmentIntersection(
  a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint,
): { x: number; z: number; t: number; u: number } | null {
  const rx = b.x - a.x, rz = b.z - a.z;
  const sx = d.x - c.x, sz = d.z - c.z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / denom;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * rx, z: a.z + t * rz, t, u };
}

/**
 * Resolves which side of a crossing sits above the other, given each side's own
 * normalized structure/layer. Structure decides first (bridge > ground/ford > tunnel);
 * `layer` only breaks a tie between two roads of the same structure rank. Both tying
 * (e.g. two plain roads on the same layer that happen to cross) is `'unresolved'` — not
 * a conflict this module has evidence to resolve, and not something it guesses.
 */
export function resolveCrossing(road: RoadStructureInfo, other: RoadStructureInfo): 'road' | 'other' | 'unresolved' {
  const rankRoad = STRUCTURE_RANK[road.structure];
  const rankOther = STRUCTURE_RANK[other.structure];
  if (rankRoad !== rankOther) return rankRoad > rankOther ? 'road' : 'other';
  if (road.layer !== other.layer) return road.layer > other.layer ? 'road' : 'other';
  return 'unresolved';
}

interface RoadBounds { minX: number; maxX: number; minZ: number; maxZ: number }

function boundsOf(points: LocalPoint[]): RoadBounds {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { minX, maxX, minZ, maxZ };
}

function boundsOverlap(a: RoadBounds, b: RoadBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function crossingsBetween(
  roadA: WorldRoad, infoA: RoadStructureInfo, distA: number[],
  roadB: WorldRoad, infoB: RoadStructureInfo, distB: number[],
): RoadCrossing[] {
  const out: RoadCrossing[] = [];
  for (let ai = 0; ai < roadA.points.length - 1; ai += 1) {
    for (let bi = 0; bi < roadB.points.length - 1; bi += 1) {
      const hit = segmentIntersection(roadA.points[ai], roadA.points[ai + 1], roadB.points[bi], roadB.points[bi + 1]);
      if (!hit) continue;
      const point = { x: hit.x, z: hit.z };
      const distanceAlongA = distA[ai] + hit.t * (distA[ai + 1] - distA[ai]);
      const distanceAlongB = distB[bi] + hit.u * (distB[bi + 1] - distB[bi]);
      const resolution = resolveCrossing(infoA, infoB);
      out.push({ roadId: roadA.id, otherRoadId: roadB.id, point, distanceAlong: distanceAlongA, otherDistanceAlong: distanceAlongB, resolution });
      out.push({
        roadId: roadB.id, otherRoadId: roadA.id, point, distanceAlong: distanceAlongB, otherDistanceAlong: distanceAlongA,
        resolution: resolution === 'road' ? 'other' : resolution === 'other' ? 'road' : 'unresolved',
      });
    }
  }
  return out;
}

/**
 * Side of one cell in the crossing search's grid, in meters. A z14 tile is roughly 1.2 km
 * across and the roads inside it are a few hundred meters long at most, so a
 * quarter-kilometre cell puts almost every road in one or two cells while keeping the
 * number of cells over a 2.8 km fetch in the hundreds rather than the thousands.
 */
const CROSSING_GRID_CELL_METERS = 250;

/**
 * Finds every crossing between two *different* roads where at least one side carries
 * grade-separation evidence (a non-`'ground'` structure, or a non-zero `layer`). An
 * ordinary at-grade intersection — two plain roads, both layer 0 — is never searched
 * for: it has no ordering evidence at all, and every normal street junction in the
 * world is one of these, so treating them as candidate crossings would cost an O(n^2)
 * pair enumeration for nothing. Only pairs with at least one "special" road (bridge,
 * tunnel, ford, or non-zero layer) are considered at all.
 *
 * "Proportional to the bridges, not to the whole road count" was the intent, but pairing
 * every special road against every *other* road is still a product, and a real snapshot
 * is not sparse in bridges: Svartaksi's own opening fetch has 646 special roads out of
 * 10 840, which is seven million pairs — each of which built a two-id string and inserted
 * it into a Set *before* the bounding-box reject ever ran. That was ~23 seconds of
 * unyielded main-thread work, and the larger half of the game freezing on "Assembling
 * streets, water and rooftops".
 *
 * So candidates now come out of a uniform grid over road bounding boxes: a special road
 * only ever meets roads filed in the cells its own box covers. The result is identical,
 * order included — the outer loop is still `special` in input order, candidates are still
 * visited in ascending input index, and a special/special pair is still handled once from
 * the earlier road's side, which is exactly what the old first-come pair set worked out
 * to.
 *
 * A pair that *does* carry evidence but where `resolveCrossing` still can't decide which
 * side is above (e.g. two bridges crossing on the same layer) is still returned, with
 * `resolution: 'unresolved'` — that's the case backlog item 8 calls out for debug
 * inspection rather than a guess.
 */
export function findRoadCrossings(roads: WorldRoad[]): RoadCrossing[] {
  return crossingsFromIndex(indexRoads(roads));
}

/** Whether a road carries any grade-separation evidence at all — a non-`'ground'`
 * structure, or a non-zero `layer`. A plain road on layer 0 crossing another plain road
 * on layer 0 is an ordinary junction with nothing to resolve, which is what makes the
 * crossing search proportional to the bridges rather than to the whole road count. */
function hasSeparationEvidence(info: RoadStructureInfo): boolean {
  return info.structure !== 'ground' || info.layer !== 0;
}

/**
 * The per-road derived data both searches over a road set need — cumulative distances,
 * normalized structure, bounding boxes, and the grid that turns "which roads are near
 * this one" into a bounded lookup. Built once per `buildRoadElevationProfiles` call and
 * shared by the crossing search and the shared-node junction lookup, rather than each
 * walking every road's points again.
 */
interface RoadIndex {
  roads: WorldRoad[];
  distances: number[][];
  infos: RoadStructureInfo[];
  bounds: RoadBounds[];
  grid: SpatialGrid<number>;
}

function indexRoads(roads: WorldRoad[]): RoadIndex {
  const distances: number[][] = new Array(roads.length);
  const infos: RoadStructureInfo[] = new Array(roads.length);
  const bounds: RoadBounds[] = new Array(roads.length);
  for (let index = 0; index < roads.length; index += 1) {
    const road = roads[index];
    distances[index] = cumulativeDistances(road.points);
    infos[index] = structureInfo(road);
    bounds[index] = boundsOf(road.points);
  }
  // Candidate lookup by area: a special road only ever meets roads filed in the cells its
  // own bounding box covers. Indices rather than roads, so the crossing list can be kept
  // in input order without sorting by id.
  const grid = createSpatialGrid(
    bounds.map((_, index) => index),
    (index) => (Number.isFinite(bounds[index].minX) ? bounds[index] : null),
    { cellMeters: CROSSING_GRID_CELL_METERS },
  );
  return { roads, distances, infos, bounds, grid };
}

function crossingsFromIndex({ roads, distances, infos, bounds, grid }: RoadIndex): RoadCrossing[] {
  const crossings: RoadCrossing[] = [];

  // "No separation evidence at all" is the only case worth skipping outright (see
  // hasSeparationEvidence). Anything else — including two same-layer bridges, which do
  // carry evidence, just not enough to resolve which is above — is worth searching so
  // resolveCrossing's own 'unresolved' outcome has a chance to surface.
  const special: number[] = [];
  for (let index = 0; index < roads.length; index += 1) {
    if (hasSeparationEvidence(infos[index])) special.push(index);
  }
  if (!special.length) return crossings;

  // Stamp-marking instead of a fresh Set per special road: a road filed in four cells
  // would otherwise be considered four times over, and allocating and clearing a Set for
  // every bridge costs more than the search it guards. -1 can never be a road index, so
  // the array needs no reset between roads.
  const consideredBy = new Int32Array(roads.length).fill(-1);
  const candidates: number[] = [];

  for (const indexA of special) {
    const boundsA = bounds[indexA];
    if (!Number.isFinite(boundsA.minX)) continue;
    candidates.length = 0;
    grid.forEachNear(boundsA, (indexB) => {
      if (consideredBy[indexB] === indexA) return;
      consideredBy[indexB] = indexA;
      candidates.push(indexB);
    });
    // Input order, so the crossing list comes out exactly as the unindexed search's did.
    candidates.sort((a, b) => a - b);

    const roadA = roads[indexA];
    const infoA = infos[indexA];
    for (const indexB of candidates) {
      if (indexA === indexB) continue;
      // A special/special pair is reachable from both sides: take it from the earlier
      // road only, which is what the old first-come pair set amounted to.
      if (indexB < indexA && hasSeparationEvidence(infos[indexB])) continue;
      if (!boundsOverlap(boundsA, bounds[indexB])) continue;
      crossings.push(...crossingsBetween(
        roadA, infoA, distances[indexA],
        roads[indexB], infos[indexB], distances[indexB],
      ));
    }
  }
  return crossings;
}

export interface RoadElevationSample {
  distanceAlong: number;
  point: LocalPoint;
  height: number;
}

export interface RoadElevationProfile {
  roadId: string;
  structure: RoadStructure;
  layer: number;
  /** The road's own paved width, carried here so `roadElevationAtPoint` can answer
   * "which deck covers this point" from the profile map alone — see its doc comment. */
  width: number;
  samples: RoadElevationSample[];
  /** Crossings involving this road that neither structure nor layer could resolve —
   * surfaced for debug inspection instead of an assumed height. */
  unresolvedCrossings: RoadCrossing[];
}

/** Matches threeWorld.ts's own small class-based surface offset — see
 * `roadSurfaceElevation` there. Kept as the floor here too so a profile-driven road and
 * a plain one from that file agree on where "ground level" starts. */
const DEFAULT_ROAD_BASE_ELEVATION = 0.14;
/** Clearance above a park/landuse mound a road keeps once it's forced to climb over one
 * — mirrors threeWorld.ts's ROAD_TERRAIN_CLEARANCE. */
const ROAD_TERRAIN_CLEARANCE = 0.08;
/** Meters of elevation change allowed per meter traveled — mirrors threeWorld.ts's
 * ROAD_ELEVATION_MAX_SLOPE. Reused here (not imported, since threeWorld.ts pulls in
 * three.js) so approach ramps for grade separation obey the same limit as ordinary
 * terrain-clearance ramps. */
const ROAD_ELEVATION_MAX_SLOPE = 0.06;

/** How far a bridge deck's underside sits below its top surface, in meters — see
 * `deckThicknessProfile` in `threeWorld.ts`, which extrudes the slab, and
 * `bridgeDeckColliders`, which gives that slab its collision box. Enough to read as a slab
 * looking up from underneath without exaggerating the deck past what a real girder
 * bridge's structural depth would be at this scale. It lives here rather than with the
 * geometry because the clearance below has to be measured from the underside: a deck
 * lifted by only the headroom would leave its own slab hanging in that headroom. */
export const BRIDGE_DECK_THICKNESS = 0.4;

/** Vertical clearance a road resolved "above" a crossing keeps over whatever it passes
 * over — enough for ordinary road/bus traffic underneath, not a rail loading gauge.
 * Measured to the deck's *underside*, so the slab's own depth is added on top. */
export const CROSSING_VERTICAL_CLEARANCE = 4.5 + BRIDGE_DECK_THICKNESS;

/**
 * How high a road tagged `bridge` stands over its own terrain baseline even where nothing
 * crosses underneath it.
 *
 * Crossing resolution alone only ever lifts a bridge that meets another *road*, and in a
 * city built on water most bridges cross none: they span a channel, a rail cut or a park,
 * so every one of them rendered as a ribbon lying 14cm above the water it was supposed to
 * carry traffic over. A deck is a deck because it was tagged one — that is source
 * evidence, exactly like `structure` is everywhere else in this module — so a tagged span
 * gets a deck's height whether or not the crossing search found something beneath it.
 *
 * Deliberately far below CROSSING_VERTICAL_CLEARANCE: this is "stands clear of what it
 * spans", not "a bus fits underneath". Where a crossing *is* found, the clearance it asks
 * for is larger and wins outright.
 */
export const BRIDGE_MIN_DECK_LIFT = 2.2;

/**
 * The lift a span of this length is actually given, which is the ceiling above capped by
 * what the bridge's own length can pay for: at `maxGrade`, a lift of `L` needs `L/maxGrade`
 * meters of approach ramp on each side, so capping the lift at `spanLength * maxGrade`
 * keeps each ramp no longer than the bridge it serves.
 *
 * Without the cap a six-metre footbridge over a ditch — which OSM tags exactly like a
 * motorway viaduct — would climb the full ceiling and push a 37m ramp into the footpaths at
 * both ends, turning a kerb-height hump into the largest earthwork in the neighbourhood.
 */
export function bridgeDeckLift(spanLength: number, maxGrade: number, ceiling = BRIDGE_MIN_DECK_LIFT): number {
  return Math.max(0, Math.min(ceiling, spanLength * maxGrade));
}

/**
 * Lift above a road's own ground baseline at which it stops being a ribbon lying on the
 * ground and starts being a deck standing over it. Terrain clearance alone can only ever
 * account for a landuse mound, and the tallest of those (a wood) tops out near 1.1m plus
 * ROAD_TERRAIN_CLEARANCE — so anything past this is grade separation, not a road riding
 * over a park boundary. Rendering reads it to decide which geometry needs to occlude
 * what passes underneath (see threeWorld.ts's road block).
 */
export const ROAD_DECK_LIFT = 1.5;

/** True if any part of this profile stands a deck's height over `baseElevation` — the
 * road's own at-grade surface height, which is the caller's to supply because the
 * class-based offset lives in threeWorld.ts (`roadSurfaceElevation`). */
export function isElevatedRoadProfile(profile: RoadElevationProfile, baseElevation: number): boolean {
  for (const sample of profile.samples) {
    if (sample.height - baseElevation > ROAD_DECK_LIFT) return true;
  }
  return false;
}

/**
 * How close two road vertices have to be, in meters, to count as the same physical node.
 *
 * Two OSM ways that share a junction node are decoded independently and their
 * coordinates are quantized to the vector tile's own extent grid (roughly 0.3m at z14),
 * so their copies of that node rarely land on the same float. Wide enough to absorb
 * that, far narrower than any road's width, so two genuinely distinct nodes a lane apart
 * never merge into one.
 *
 * Crossings are deliberately *not* found this way: grade-separated ways do not share a
 * node in OSM precisely because they do not meet, which is what makes vertex coincidence
 * the right evidence for "these two roads are physically joined and must agree on a
 * height here" — see propagateRampsAcrossJunctions.
 */
const JUNCTION_SNAP_METERS = 0.75;

/** Side of one cell in the shared-node lookup's grid, in meters. Small enough that a
 * lookup scans a handful of vertices rather than a whole neighbourhood's worth, large
 * enough that a 2.8km fetch files ~100k vertices into tens of thousands of buckets
 * rather than millions. */
const JUNCTION_CELL_METERS = 20;

interface RoadNode {
  roadIndex: number;
  vertex: number;
}

/**
 * A hash grid over every road *vertex*, so "which other roads have a vertex at this
 * point" is a lookup over the four cells the snap radius can straddle rather than a scan
 * of the whole road set.
 *
 * Built lazily and only once per `buildRoadElevationProfiles` call, and only when
 * something actually needs a ramp propagated — a snapshot with no grade separation in it
 * never pays for this at all. Cell keys are packed integers rather than strings: filing
 * a hundred thousand vertices is the whole cost of the structure, and string keys were
 * what made the old crossing search's own bookkeeping dominate the build.
 */
function createNodeIndex(roads: WorldRoad[]): (point: LocalPoint, excludeRoadIndex: number) => RoadNode[] {
  const cellOf = (value: number) => Math.floor(value / JUNCTION_CELL_METERS);
  // Packing offset: keeps a negative cell index (the world origin is a spawn point, not a
  // corner) positive before it is folded into one number.
  const CELL_ORIGIN = 1 << 15;
  const keyOf = (cellX: number, cellZ: number) => (cellX + CELL_ORIGIN) * (1 << 16) + (cellZ + CELL_ORIGIN);

  const cells = new Map<number, RoadNode[]>();
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
    const points = roads[roadIndex].points;
    for (let vertex = 0; vertex < points.length; vertex += 1) {
      const point = points[vertex];
      if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
      const key = keyOf(cellOf(point.x), cellOf(point.z));
      const bucket = cells.get(key);
      if (bucket) bucket.push({ roadIndex, vertex });
      else cells.set(key, [{ roadIndex, vertex }]);
    }
  }

  return (point, excludeRoadIndex) => {
    const found: RoadNode[] = [];
    const loX = cellOf(point.x - JUNCTION_SNAP_METERS);
    const hiX = cellOf(point.x + JUNCTION_SNAP_METERS);
    const loZ = cellOf(point.z - JUNCTION_SNAP_METERS);
    const hiZ = cellOf(point.z + JUNCTION_SNAP_METERS);
    for (let cellX = loX; cellX <= hiX; cellX += 1) {
      for (let cellZ = loZ; cellZ <= hiZ; cellZ += 1) {
        const bucket = cells.get(keyOf(cellX, cellZ));
        if (!bucket) continue;
        for (const node of bucket) {
          if (node.roadIndex === excludeRoadIndex) continue;
          const other = roads[node.roadIndex].points[node.vertex];
          if (Math.abs(other.x - point.x) > JUNCTION_SNAP_METERS) continue;
          if (Math.abs(other.z - point.z) > JUNCTION_SNAP_METERS) continue;
          found.push(node);
        }
      }
    }
    return found;
  };
}

function groundDefaultHeight(point: LocalPoint, terrain: TerrainIndex, base: number): number {
  const ground = terrainHeightAtIndexed(point, terrain);
  return ground > 0 ? Math.max(base, ground + ROAD_TERRAIN_CLEARANCE) : base;
}

/** Slope-limited dilation toward peaks: never below `raw`, and any rise is spread over
 * at least `1/maxGrade` meters per meter of height — the technique threeWorld.ts's
 * `smoothedRoadElevations` already uses for terrain mounds, reused here so a bridge's
 * lift ramps in exactly as gently. */
function maxTwoPass(raw: number[], segmentLength: number[], maxGrade: number): number[] {
  const count = raw.length;
  if (count < 2) return raw.slice();
  const left = raw.slice();
  for (let index = 1; index < count; index += 1) {
    left[index] = Math.max(raw[index], left[index - 1] - segmentLength[index - 1] * maxGrade);
  }
  const right = raw.slice();
  for (let index = count - 2; index >= 0; index -= 1) {
    right[index] = Math.max(raw[index], right[index + 1] - segmentLength[index] * maxGrade);
  }
  return raw.map((_, index) => Math.max(left[index], right[index]));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Height that would apply to `roadId` at `distanceAlong`, read out of its own already
 * (terrain-only) baseline heights before any crossing adjustment — used to size the
 * clearance the *other* side of a crossing needs, without a circular dependency on the
 * other road's still-being-computed final profile. */
function baselineHeightAt(baseline: number[], cumDist: number[], distanceAlong: number): number {
  if (distanceAlong <= cumDist[0]) return baseline[0];
  const last = cumDist.length - 1;
  if (distanceAlong >= cumDist[last]) return baseline[last];
  for (let index = 1; index <= last; index += 1) {
    if (distanceAlong <= cumDist[index]) {
      const span = cumDist[index] - cumDist[index - 1];
      const t = span > 1e-9 ? (distanceAlong - cumDist[index - 1]) / span : 0;
      return lerp(baseline[index - 1], baseline[index], t);
    }
  }
  return baseline[last];
}

/** The segment index whose span contains `distanceAlong`, so a crossing's clearance
 * requirement can be applied to that segment's own two endpoints. */
function segmentIndexAt(cumDist: number[], distanceAlong: number): number {
  for (let index = 0; index < cumDist.length - 1; index += 1) {
    if (distanceAlong <= cumDist[index + 1]) return index;
  }
  return Math.max(0, cumDist.length - 2);
}

/**
 * Builds one `RoadElevationProfile` per road that actually needs one: any road carrying
 * bridge/tunnel/ford/non-zero-layer evidence, any plain road resolved as the *other*
 * side of one of those roads' crossings (needed to size that crossing's clearance, even
 * though the plain road's own profile stays at its terrain baseline), and any road a
 * lift has to ramp out through to get back to ground level (see
 * `propagateRampsAcrossJunctions`). Every other road — the overwhelming majority in an
 * ordinary city block — never enters this map at all: `buildRoadGeometry` falls back to
 * the plain terrain-only path for those, at zero extra cost. See `findRoadCrossings` for
 * why the search itself is bounded the same way.
 *
 * Deterministic and order-independent: every crossing's clearance is sized off both
 * sides' plain terrain-cleared baselines (computed once, lazily, per road), never off
 * another road's own already-adjusted profile — so rebuilding from the same
 * `roads`/`terrain` always yields byte-identical output regardless of road order.
 */
export function* buildRoadElevationProfilesJob(
  roads: WorldRoad[],
  terrain: TerrainClearance[] = [],
  options: {
    clearance?: number;
    maxGrade?: number;
    deckLift?: number;
    baseElevation?: (road: WorldRoad) => number;
    /**
     * The caller's own index over `terrain`, when it has one. This function asks for the
     * ground height once per point of every road it profiles — hundreds to thousands of
     * queries against an array that holds ~1000 landuse polygons — and a linear scan per
     * query was measured as the single dominant cost of the whole build (see
     * `docs/performance/2026-09-04-road-elevation-terrain-index.md`). Omit it and an index
     * is built here instead, which is still far cheaper than scanning; pass the one you
     * already have to skip even that.
     */
    terrainIndex?: TerrainIndex;
  } = {},
): Generator<void, Map<string, RoadElevationProfile>, void> {
  const clearance = options.clearance ?? CROSSING_VERTICAL_CLEARANCE;
  const terrainIndex = options.terrainIndex ?? buildTerrainIndex(terrain);
  const maxGrade = options.maxGrade ?? ROAD_ELEVATION_MAX_SLOPE;
  const deckLiftCeiling = options.deckLift ?? BRIDGE_MIN_DECK_LIFT;
  const baseElevationOf = options.baseElevation ?? (() => DEFAULT_ROAD_BASE_ELEVATION);

  // The two heaviest single calls in this function (the road/node index below and the
  // ramp relaxation further down) have no yield inside them, so each is bracketed instead:
  // see the phase timings in docs/performance/2026-09-04-road-elevation-slicing.md for
  // which ones are actually worth the seam.
  const index = indexRoads(roads);
  yield;
  const roadIndexById = new Map(roads.map((road, position) => [road.id, position]));
  const roadById = new Map(roads.map((road) => [road.id, road]));
  const baseline = new Map<string, number[]>();
  const cumDist = new Map<string, number[]>();
  const segLengths = new Map<string, number[]>();
  const rawTarget = new Map<string, number[]>();
  const infoById = new Map<string, RoadStructureInfo>();
  const unresolved = new Map<string, RoadCrossing[]>();
  /** Roads a crossing actually moved off their own terrain baseline — the only ones with
   * anything to hand on to a neighbour. The rest of the profiled set (a plain road pulled
   * in only to size a crossing's clearance) sits exactly where the terrain put it, so
   * relaxing it would compute a full pair of slope sweeps to discover it has nothing to
   * say. */
  const offGround = new Set<string>();

  const ensure = (roadId: string): void => {
    if (baseline.has(roadId)) return;
    const road = roadById.get(roadId);
    if (!road) return;
    const base = baseElevationOf(road);
    const heights = road.points.map((point) => groundDefaultHeight(point, terrainIndex, base));
    const distances = index.distances[roadIndexById.get(roadId)!];
    const lengths: number[] = [];
    for (let position = 0; position < distances.length - 1; position += 1) {
      lengths.push(distances[position + 1] - distances[position]);
    }
    baseline.set(roadId, heights);
    cumDist.set(roadId, distances);
    segLengths.set(roadId, lengths);
    rawTarget.set(roadId, heights.slice());
    infoById.set(roadId, structureInfo(road));
    unresolved.set(roadId, []);
  };

  /** The road's height as it stands right now: its lower bounds dilated, slope-limited.
   * The one place a height is ever read from, so the propagation below and the profiles
   * emitted at the end cannot disagree about what a road's surface currently does.
   *
   * Only lower bounds: since every crossing is resolved by raising the winner, a height
   * never travels downward and there is nothing to erode against. The upper-bound pass
   * this used to intersect with existed solely for the tunnel dig. */
  const currentHeights = (roadId: string): number[] =>
    maxTwoPass(rawTarget.get(roadId)!, segLengths.get(roadId)!, maxGrade);

  const crossings = crossingsFromIndex(index);
  // Resolve lower structures first so stacked bridges clear the actual lower deck.
  crossings.sort((a, b) => {
    const left = structureInfo(roadById.get(a.roadId)!);
    const right = structureInfo(roadById.get(b.roadId)!);
    return STRUCTURE_RANK[left.structure] - STRUCTURE_RANK[right.structure]
      || left.layer - right.layer || a.roadId.localeCompare(b.roadId);
  });
  yield;
  for (let position = 0; position < crossings.length; position += 1) {
    if (position > 0 && position % PROFILE_CHUNK === 0) yield;
    ensure(crossings[position].roadId);
    ensure(crossings[position].otherRoadId);
  }
  yield;

  // A tagged bridge is a deck whether or not the crossing search found a road beneath it
  // — see BRIDGE_MIN_DECK_LIFT. Crossings read this lift too: an upper deck must
  // clear the lower bridge itself, not the terrain below both of them.
  for (let position = 0; position < roads.length; position += 1) {
    if (position > 0 && position % PROFILE_CHUNK === 0) yield;
    const road = roads[position];
    if (structureInfo(road).structure !== 'bridge') continue;
    ensure(road.id);
    const distances = cumDist.get(road.id);
    if (!distances || distances.length < 2) continue;
    const lift = bridgeDeckLift(distances[distances.length - 1], maxGrade, deckLiftCeiling);
    if (lift <= JUNCTION_HEIGHT_EPSILON) continue;
    const target = rawTarget.get(road.id)!;
    const base = baseline.get(road.id)!;
    for (let position = 0; position < target.length; position += 1) {
      target[position] = Math.max(target[position], base[position] + lift);
    }
    offGround.add(road.id);
  }
  yield;
  for (let position = 0; position < crossings.length; position += 1) {
    if (position > 0 && position % PROFILE_CHUNK === 0) yield;
    const crossing = crossings[position];
    if (crossing.resolution === 'unresolved') {
      unresolved.get(crossing.roadId)?.push(crossing);
      continue;
    }
    // Each undirected crossing is emitted twice (once from each road's perspective) —
    // only process the 'road'-side entry so the winner/loser pair below is handled once.
    if (crossing.resolution !== 'road') continue;

    const roadId = crossing.roadId;
    const otherId = crossing.otherRoadId;
    const otherBaseline = currentHeights(otherId);
    const roadDist = cumDist.get(roadId)!;
    const otherDist = cumDist.get(otherId)!;

    const otherHeightHere = baselineHeightAt(otherBaseline, otherDist, crossing.otherDistanceAlong);

    // Every crossing is resolved the same way: the winner rises to clear the loser.
    //
    // A tunnel used to be dug *down* instead, which is what a tunnel physically does and
    // is wrong for this renderer. The ground is one opaque, unbroken plane at y=0 with no
    // hole in it, so nothing below grade can be seen: the cut, the retaining walls built
    // for it, and the car driving down into it all disappeared under the plane, and a
    // player watching a street ramp into the ground saw the road and their own vehicle
    // swallowed by it. Digging expressed a truth the world had no way to show.
    //
    // Raising says the same thing in the vocabulary this world does have, and is the
    // precedent BRIDGE_MIN_DECK_LIFT already set for spans that cross nothing. The
    // tunnel's own carriageway is never painted either way (see surfaceVisibility), so
    // what changes is only which side of the crossing carries the separation.
    //
    // The cost is honest and is the reason this is a judgement rather than a fix: a
    // tunnel bored under a hill now nudges the road above it into a slight hump, where
    // a real tunnel passes beneath undisturbed ground. That is a smaller and rarer wrong
    // than a street that eats the player.
    const segment = segmentIndexAt(roadDist, crossing.distanceAlong);
    const target = rawTarget.get(roadId)!;
    const required = otherHeightHere + clearance;
    target[segment] = Math.max(target[segment], required);
    target[segment + 1] = Math.max(target[segment + 1], required);
    offGround.add(roadId);
  }

  yield;
  propagateRampsAcrossJunctions({
    roads, index, roadById, roadIndexById, baseline, rawTarget, offGround, ensure, currentHeights,
  });
  yield;

  const profiles = new Map<string, RoadElevationProfile>();
  let emitted = 0;
  for (const roadId of baseline.keys()) {
    emitted += 1;
    // Each of these runs two slope sweeps over the road (currentHeights), so this loop is
    // real work rather than bookkeeping.
    if (emitted % PROFILE_CHUNK === 0) yield;
    const road = roadById.get(roadId);
    if (!road) continue;
    const cd = cumDist.get(roadId)!;
    const final = currentHeights(roadId);
    const info = infoById.get(roadId)!;
    profiles.set(roadId, {
      roadId,
      structure: info.structure,
      layer: info.layer,
      width: road.width,
      samples: road.points.map((point, position) => ({ distanceAlong: cd[position], point, height: final[position] })),
      unresolvedCrossings: unresolved.get(roadId) ?? [],
    });
  }
  return profiles;
}

/**
 * The whole job, run to completion. Every caller outside the sliced world build wants this
 * — tests, and anything that needs profiles before it can do anything else — and it is
 * also what keeps the generator above honest: there is exactly one implementation, so a
 * sliced build and an eager one cannot produce different profiles.
 */
export function buildRoadElevationProfiles(
  roads: WorldRoad[],
  terrain: TerrainClearance[] = [],
  options: Parameters<typeof buildRoadElevationProfilesJob>[2] = {},
): Map<string, RoadElevationProfile> {
  const job = buildRoadElevationProfilesJob(roads, terrain, options);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

/**
 * Items per yield inside this builder's own loops.
 *
 * Sized so one chunk is well under a frame's build budget (WORLD_BUILD_BUDGET_MS is 4ms)
 * without making the generator machinery itself the cost: at ~3000 nearby roads the whole
 * emit loop is under 2ms, so a few hundred items is a fraction of a millisecond per chunk
 * and the scheduler still gets a dozen-odd chances to hand the frame back.
 */
const PROFILE_CHUNK = 256;

/** A height difference below this (1mm) is not a slope anyone can see and not a step
 * anything can fall off — the floor that stops the relaxation below from chasing
 * floating-point dust from one road to the next forever. */
const JUNCTION_HEIGHT_EPSILON = 1e-3;

/**
 * Hard stop on the relaxation, so a pathological snapshot degrades into a slightly
 * shorter ramp rather than a hung build. Not normally approached: every hop sheds
 * `maxGrade` meters of lift per meter travelled, so a full CROSSING_VERTICAL_CLEARANCE
 * lift is spent inside ~75m of road no matter how many ways that 75m is cut into.
 */
const MAX_JUNCTION_RELAXATION_STEPS = 20_000;

/**
 * Carries a lift out through the junctions at a road's ends until it has
 * ramped back to ground level, pulling whatever roads it passes through into the profile
 * set on the way.
 *
 * Without this a deck simply stops in mid-air. OSM tags a bridge over exactly the span
 * it bridges, and that way is usually far shorter than the ~75m a
 * CROSSING_VERTICAL_CLEARANCE lift needs to ramp out at ROAD_ELEVATION_MAX_SLOPE, so
 * smoothing the bridge way alone leaves both its ends several meters above the ordinary
 * streets they join — a cliff the deck geometry ends on and a step physics drops a
 * vehicle off. Backlog item 8 calls for exactly this: "continuous approach ramps within
 * a defined maximum grade, extending beyond the tagged span when necessary".
 *
 * The evidence used is vertex coincidence (see JUNCTION_SNAP_METERS). Two ways sharing a
 * node meet physically and therefore must agree on a height there; two ways that cross
 * without sharing one — which is what grade separation looks like in OSM — must not, and
 * are left to the crossing resolution above. So the propagation can never flatten a
 * crossing it was built to separate.
 *
 * Mechanically this is a monotone relaxation over the same slope-limited bound the rest
 * of the module uses: a raised node only ever raises a neighbour's lower bound, and a road
 * is only revisited when that bound actually moved. Because the bound only travels in one
 * direction and the loop runs to quiescence, the result does not depend on which road is
 * relaxed first.
 * Ordinary roads are never touched: a road whose height matches its own terrain baseline
 * everywhere propagates nothing, which is what keeps a flat city's profile map empty.
 *
 * Known limitation: a road that both passes under a deck and joins that deck's approach
 * a short way off gets raised by the approach, which eats into the clearance the crossing
 * asked for. Real junction layouts avoid this by not putting the two within a ramp length
 * of each other; the profile does not currently detect the case.
 */
function propagateRampsAcrossJunctions(state: {
  roads: WorldRoad[];
  index: RoadIndex;
  roadById: Map<string, WorldRoad>;
  roadIndexById: Map<string, number>;
  baseline: Map<string, number[]>;
  rawTarget: Map<string, number[]>;
  offGround: Set<string>;
  ensure: (roadId: string) => void;
  currentHeights: (roadId: string) => number[];
}): void {
  const { roads, index, roadById, roadIndexById, baseline, rawTarget, offGround, ensure, currentHeights } = state;
  if (offGround.size === 0) return;

  const nodesAt = createNodeIndex(roads);
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueue = (roadId: string) => {
    if (queued.has(roadId)) return;
    queued.add(roadId);
    queue.push(roadId);
  };
  // Seeded in input order rather than in the order crossings happened to touch roads, so
  // a snapshot relaxes the same way however its roads were listed.
  for (const road of roads) if (offGround.has(road.id)) enqueue(road.id);

  let cursor = 0;
  let steps = 0;
  while (cursor < queue.length && steps < MAX_JUNCTION_RELAXATION_STEPS) {
    steps += 1;
    const roadId = queue[cursor];
    cursor += 1;
    queued.delete(roadId);
    // The consumed prefix is dropped once it dominates, so a long relaxation doesn't grow
    // an unbounded array behind the cursor.
    if (cursor > 512 && cursor * 2 > queue.length) {
      queue.splice(0, cursor);
      cursor = 0;
    }

    const road = roadById.get(roadId)!;
    const heights = currentHeights(roadId);
    const base = baseline.get(roadId)!;
    for (let vertex = 0; vertex < road.points.length; vertex += 1) {
      const lift = heights[vertex] - base[vertex];
      if (Math.abs(lift) <= JUNCTION_HEIGHT_EPSILON) continue;
      for (const node of nodesAt(road.points[vertex], roadIndexById.get(roadId)!)) {
        const neighbour = index.roads[node.roadIndex];
        ensure(neighbour.id);
        if (!baseline.has(neighbour.id)) continue;
        const target = rawTarget.get(neighbour.id)!;
        if (heights[vertex] <= target[node.vertex] + JUNCTION_HEIGHT_EPSILON) continue;
        target[node.vertex] = heights[vertex];
        offGround.add(neighbour.id);
        enqueue(neighbour.id);
      }
    }
  }
}

/** Interpolated height along one road's own profile at `distanceAlong`, clamped to the
 * profile's own span. The one function rendering and physics both call — see this
 * file's header comment. */
export function sampleRoadElevation(profile: RoadElevationProfile, distanceAlong: number): number {
  const samples = profile.samples;
  if (samples.length === 0) return DEFAULT_ROAD_BASE_ELEVATION;
  if (samples.length === 1) return samples[0].height;
  if (distanceAlong <= samples[0].distanceAlong) return samples[0].height;
  const lastIndex = samples.length - 1;
  if (distanceAlong >= samples[lastIndex].distanceAlong) return samples[lastIndex].height;
  for (let index = 1; index <= lastIndex; index += 1) {
    if (distanceAlong <= samples[index].distanceAlong) {
      const prev = samples[index - 1];
      const curr = samples[index];
      const span = curr.distanceAlong - prev.distanceAlong;
      const t = span > 1e-9 ? (distanceAlong - prev.distanceAlong) / span : 0;
      return lerp(prev.height, curr.height, t);
    }
  }
  return samples[lastIndex].height;
}

/**
 * Side of one cell in the point-query index below, in meters. Sized to the *queries*
 * (a wheel contact point, a footfall — effectively a point) rather than to the roads, so
 * the only thing that matters is that a cell holds few enough profiles to scan.
 */
const ELEVATION_QUERY_CELL_METERS = 60;

/**
 * Point-query index over one profile map, memoized on the map itself.
 *
 * `roadElevationAtPoint` is called from the physics ground callback, which runs a couple
 * of hundred point queries per tick, and the profile map has grown well past the tagged
 * decks it used to hold — approach ramps are in it now too. Scanning every profile per
 * query was the cost that put on the physics step; a grid turns it back into the handful
 * of profiles whose own polyline is anywhere near the point.
 *
 * A profile map is built whole by `buildRoadElevationProfiles` and never mutated
 * afterwards, which is what makes memoizing on its identity safe: a rebuild produces a
 * new map, and the old index goes with the old map.
 */
const elevationQueryIndexes = new WeakMap<Map<string, RoadElevationProfile>, SpatialGrid<RoadElevationProfile>>();

function elevationQueryIndex(profiles: Map<string, RoadElevationProfile>): SpatialGrid<RoadElevationProfile> {
  const cached = elevationQueryIndexes.get(profiles);
  if (cached) return cached;
  const values = [...profiles.values()];
  const grid = createSpatialGrid(
    values,
    (profile) => {
      const bounds = boundsOf(profile.samples.map((sample) => sample.point));
      if (!Number.isFinite(bounds.minX)) return null;
      // Padded by the road's own half-width, since a point off the end of the polyline
      // but still on the pavement has to reach the profile that covers it.
      const reach = Math.max(0.5, profile.width / 2) + profile.width * 1.5;
      return { minX: bounds.minX - reach, maxX: bounds.maxX + reach, minZ: bounds.minZ - reach, maxZ: bounds.maxZ + reach };
    },
    { cellMeters: ELEVATION_QUERY_CELL_METERS },
  );
  elevationQueryIndexes.set(profiles, grid);
  return grid;
}

/**
 * The road-surface counterpart to `terrainHeightAt`: height of whichever profiled road's
 * own paved surface (plus `margin`) covers `(x, z)`, or `null` off every one of them.
 * Where two profiled roads both cover the point (a deck crossing over a lower road), the
 * highest surface at or below `maxHeight` wins. Movement supplies its current
 * support height plus a small step allowance so an overhead deck cannot become ground. This is what feeds the shared ground-height callback physics uses (see
 * `svartaksiRuntime.tsx`), so a car on a bridge deck is grounded on the deck, not on the
 * terrain far beneath it.
 *
 * Reads the profile map alone, not a parallel road list. A profile already carries every
 * point, its distance along the road, and the road's width, so pairing the map back up
 * with `WorldRoad`s bought nothing and cost a fresh cumulative-distance array per road
 * per query — on a callback the physics step runs several times a frame. It also removes
 * the caller's need to guess which roads are profiled: the map itself is the answer, and
 * since `buildRoadElevationProfiles` now profiles approach ramps too, a guess made from
 * `structure` alone would have dropped a car back to terrain height the moment it left
 * the tagged deck for the ramp.
 */
export function roadElevationAtPoint(
  x: number,
  z: number,
  profiles: Map<string, RoadElevationProfile>,
  margin = 0,
  maxHeight = Infinity,
  minHeight = -Infinity,
  excludeRoadId?: string,
): number | null {
  let best: number | null = null;
  // The index pads each profile by its own half-width; `margin` is the caller's extra
  // reach on top of that, so it belongs on the query box rather than in the index.
  const reach = Math.max(0, margin) * 3;
  const box = { minX: x - reach, maxX: x + reach, minZ: z - reach, maxZ: z + reach };
  // A profile filed in several cells is visited once per cell. Taking the maximum is
  // idempotent, so this is one of the "no dedupe needed" callers createSpatialGrid's own
  // comment describes.
  elevationQueryIndex(profiles).forEachNear(box, (profile) => {
    if (profile.roadId === excludeRoadId) return;
    const triangles = profileSurfaceTriangles(profile, margin);
    for (let i = 0; i < triangles.length; i += 9) {
      const height = triangleHeightAt(x, z, triangles, i);
      if (height !== null && height <= maxHeight && height >= minHeight && (best === null || height > best)) best = height;
    }
  });
  return best;
}

const profileSurfaces = new WeakMap<RoadElevationProfile, Map<number, number[]>>();

/** Cache the same triangles the renderer draws, including miters and endpoint overlaps.
 * A capsule around the centreline misses outer bends and invents round end caps. */
function profileSurfaceTriangles(profile: RoadElevationProfile, margin: number): number[] {
  let cached = profileSurfaces.get(profile);
  if (!cached) { cached = new Map(); profileSurfaces.set(profile, cached); }
  const existing = cached.get(margin);
  if (existing) return existing;
  const triangles: number[] = [];
  if (profile.samples.length >= 2) {
    const points = extendRoadEndpoints(profile.samples.map(s => s.point), profile.width);
    const frames = roadRibbonFrames(points, profile.width + margin * 2);
    const vertices = points.flatMap((point, i) => {
      const height = profile.samples[Math.max(0, Math.min(profile.samples.length - 1, i - 1))].height;
      const frame = frames[i];
      return [
        point.x + frame.offsetX, height, point.z + frame.offsetZ,
        point.x - frame.offsetX, height, point.z - frame.offsetZ,
      ];
    });
    for (let i = 0; i < points.length - 1; i += 1) {
      for (const vertex of [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3]) {
        triangles.push(vertices[vertex * 3], vertices[vertex * 3 + 1], vertices[vertex * 3 + 2]);
      }
    }
  }
  cached.set(margin, triangles);
  return triangles;
}

function triangleHeightAt(x: number, z: number, vertices: number[], i: number): number | null {
  const ax = vertices[i], az = vertices[i + 2];
  const bx = vertices[i + 3], bz = vertices[i + 5];
  const cx = vertices[i + 6], cz = vertices[i + 8];
  const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(denominator) < 1e-10) return null;
  const a = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
  const b = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
  const c = 1 - a - b;
  if (a < -1e-8 || b < -1e-8 || c < -1e-8) return null;
  return a * vertices[i + 1] + b * vertices[i + 4] + c * vertices[i + 7];
}
