/**
 * The ground: how tall each mapped landuse polygon stands, how its edge slopes down to
 * the surrounding plane, and what height a given point of the world is at.
 *
 * There is no elevation model in the data. OSM has no DEM, and the vector tiles this
 * world is built from carry no `ele` on an area — so the terrain here is *derived from
 * what the map does say*: a wood stands higher than a meadow, which stands higher than a
 * lawn, which stands higher than the tarmac of a retail park. That is not real Svartaksi
 * topography and does not pretend to be; it is a legible, consistent relief that follows
 * the land use, which is the only ground signal the source actually contains.
 *
 * Two things changed here once the world got a physics engine:
 *
 * - **The height of a polygon is a setting, not a constant.** `TerrainSettings` carries a
 *   toggle and a scale, so the relief can be flattened to a decal or exaggerated into
 *   proper hills without touching code, and both the drawn mesh and the physics ground
 *   read the same number.
 * - **Polygon edges ramp instead of stepping.** A flat-topped prism has vertical sides,
 *   and a vertical side is a wall: a car meeting the edge of a wood at 50km/h hit a metre
 *   of sheer cliff, because the boundary of a *data* polygon was being solved as though
 *   it were a retaining wall. Every polygon is now a frustum — full height in the middle,
 *   sloping down to nothing at its own outline — and `terrainHeightAt` reproduces exactly
 *   that slope, so what is drawn and what is driven on are the same surface.
 */
import { pointInRing, pointSegmentDistanceSquared, ringBounds } from './geo';
import type { LocalPoint, WorldArea } from './types';

export interface TerrainSettings {
  /** Off flattens the world to a decal: polygons keep a few centimetres of separation so
   * overlapping landuse cannot z-fight, and nothing else. */
  enabled: boolean;
  /** Multiplier on every polygon's mapped height. 1 is the surveyed-looking relief the
   * kind table describes; higher turns the same map into hills. */
  scale: number;
  /** Metres of inward ramp per metre of height — the run of the slope at a polygon's
   * edge. 0 restores hard vertical sides; 6 is roughly a 1-in-6 bank, which a car climbs
   * without noticing and a bus climbs slowly. */
  slope: number;
}

export const DEFAULT_TERRAIN_SETTINGS: TerrainSettings = { enabled: true, scale: 1, slope: 6 };

/** Bounds the sliders enforce, and the same bounds a stored value is clamped into.
 * `scale` never reaches 0: a polygon collapsed to exactly the ground plane z-fights with
 * every other polygon over it, which is what the jitter band exists to prevent. */
export const TERRAIN_SCALE_RANGE = { min: 0.2, max: 8, step: 0.1 } as const;
export const TERRAIN_SLOPE_RANGE = { min: 0, max: 24, step: 0.5 } as const;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function normalizeTerrainSettings(raw: unknown): TerrainSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_TERRAIN_SETTINGS };
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_TERRAIN_SETTINGS.enabled,
    scale: typeof input.scale === 'number' && Number.isFinite(input.scale)
      ? clamp(input.scale, TERRAIN_SCALE_RANGE.min, TERRAIN_SCALE_RANGE.max)
      : DEFAULT_TERRAIN_SETTINGS.scale,
    slope: typeof input.slope === 'number' && Number.isFinite(input.slope)
      ? clamp(input.slope, TERRAIN_SLOPE_RANGE.min, TERRAIN_SLOPE_RANGE.max)
      : DEFAULT_TERRAIN_SETTINGS.slope,
  };
}

/**
 * Height band per mapped kind, in metres: `[lowest, highest]`. A polygon takes a fixed
 * point inside its own band, chosen from a hash of its id, so two polygons of the same
 * kind are never exactly coplanar and the world does not z-fight where landuse overlaps.
 *
 * The bands are ordered the way the ground is: canopy and rock highest, rough vegetation
 * below it, managed grass below that, and paved/built landuse barely off the plane. The
 * keys are the raw `leisure` / `landuse` / `natural` values the normalizer keeps (see
 * normalize.ts), so adding a kind here is the whole job of giving it its own relief.
 */
const HEIGHT_BANDS: Record<string, readonly [number, number]> = {
  // Canopy and bare upland.
  forest: [0.6, 1.1], wood: [0.6, 1.1],
  bare_rock: [0.8, 1.4], scree: [0.55, 1], cliff: [1, 1.6], fell: [0.7, 1.2],
  // Rough vegetation.
  scrub: [0.4, 0.75], heath: [0.3, 0.55], moor: [0.45, 0.85],
  // Cultivated and open land.
  orchard: [0.35, 0.6], vineyard: [0.3, 0.5], grassland: [0.2, 0.4], meadow: [0.2, 0.4],
  farmland: [0.14, 0.28], farmyard: [0.1, 0.2], allotments: [0.12, 0.24],
  // Shorelines and soft ground, which sit *below* the vegetation around them.
  sand: [0.08, 0.18], beach: [0.06, 0.14], mud: [0.03, 0.08], wetland: [0.02, 0.07],
  // Managed green space in town: real, but nobody has to climb it.
  park: [0.1, 0.2], garden: [0.1, 0.2], grass: [0.08, 0.18], village_green: [0.08, 0.18],
  cemetery: [0.12, 0.22], recreation_ground: [0.09, 0.18], golf_course: [0.16, 0.32],
  pitch: [0.05, 0.1], playground: [0.06, 0.13],
};

/** Everything the table does not name: built or paved landuse (residential, commercial,
 * industrial, retail, railway, construction, brownfield...). These blanket entire street
 * grids, so any real height here is a kerb around every block in the city. */
const DEFAULT_BAND: readonly [number, number] = [0.06, 0.16];
/** What every kind falls back to with terrain switched off — enough to keep overlapping
 * polygons apart, low enough that a wheel never notices it. */
const FLAT_BAND: readonly [number, number] = [0.02, 0.05];

/** FNV-1a over the polygon id, mapped to 0..1. Stable across rebuilds, which is what
 * stops a polygon's height (and therefore the ground under a parked car) from changing
 * every time the world streams. */
export function stableNumber(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return (hash >>> 0) / 4_294_967_296;
}

/** How tall this polygon's mound stands, in metres. The single answer, used by the mesh
 * that is drawn, the profile the physics solves and the trees planted on top. */
export function areaTerrainHeight(
  area: WorldArea,
  settings: TerrainSettings = DEFAULT_TERRAIN_SETTINGS,
): number {
  const band = settings.enabled ? HEIGHT_BANDS[area.kind] ?? DEFAULT_BAND : FLAT_BAND;
  const height = band[0] + stableNumber(area.id) * (band[1] - band[0]);
  return settings.enabled ? height * settings.scale : height;
}

function ringMetrics(ring: LocalPoint[]): { area: number; perimeter: number } {
  let twiceArea = 0;
  let perimeter = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[previous];
    const b = ring[index];
    twiceArea += a.x * b.z - b.x * a.z;
    perimeter += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return { area: Math.abs(twiceArea) / 2, perimeter };
}

/**
 * How far in from its own outline a polygon's slope reaches.
 *
 * The requested run (`height * slope`) is capped by `area / perimeter` — half the
 * inradius of a square, and an underestimate of the largest safe inset for anything less
 * convex. A ramp wider than the polygon can hold would fold the top face through itself;
 * capping it instead turns a small polygon into a low mound with no flat top, which is
 * what a small mound looks like anyway.
 */
export function terrainRampWidth(ring: LocalPoint[], height: number, settings: TerrainSettings): number {
  if (settings.slope <= 0 || height <= 0 || ring.length < 3) return 0;
  const { area, perimeter } = ringMetrics(ring);
  if (!(perimeter > 0)) return 0;
  return Math.min(height * settings.slope, area / perimeter);
}

/**
 * A polygon's contribution to the ground: the bounding box for a cheap reject, the ring
 * itself for the exact containment test, and the height and ramp width that describe its
 * mound.
 */
export interface TerrainClearance {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  /** Metres of inward slope at the edge; 0 is a vertical side. */
  ramp: number;
  /** The polygon's own outer ring, for the exact containment test terrainHeightAt runs
   * once a point clears the bounding box. */
  ring: LocalPoint[];
}

/**
 * Height profile of every landuse/park polygon in range. Feeds terrainHeightAt, which is
 * what roads, trees and the physics ground all use to find the surface.
 *
 * Parks are solid volumes rising from y=0 (see buildParkGeometry). Without this, any road
 * whose footprint falls inside one — extremely common, since paths run through parks and
 * residential/commercial landuse routinely blankets entire street grids — renders buried
 * inside the terrain and never appears.
 */
export function computeTerrainClearance(
  parks: WorldArea[],
  settings: TerrainSettings = DEFAULT_TERRAIN_SETTINGS,
): TerrainClearance[] {
  const bounds: TerrainClearance[] = [];
  for (const park of parks) {
    const ring = park.rings[0];
    if (!ring || ring.length < 3) continue;
    const { minX, maxX, minZ, maxZ } = ringBounds(ring);
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) continue;
    const height = areaTerrainHeight(park, settings);
    bounds.push({ minX, maxX, minZ, maxZ, height, ramp: terrainRampWidth(ring, height, settings), ring });
  }
  return bounds;
}

/**
 * The `parks` toggle gate around `computeTerrainClearance`, pulled out so every caller
 * building a ground profile — the physics collider terrain in svartaksiRuntime.tsx, roads and
 * trees in threeWorld.ts, building placement in threeWorld.ts — shares the exact same
 * "landuse off means no ground" rule instead of three independent copies of the ternary
 * drifting apart. A ground the player cannot see is worse than no ground at all: with
 * landuse switched off nothing should still be climbing invisible hills.
 */
export function terrainClearanceFor(
  parksEnabled: boolean,
  parks: WorldArea[],
  settings: TerrainSettings = DEFAULT_TERRAIN_SETTINGS,
): TerrainClearance[] {
  return parksEnabled ? computeTerrainClearance(parks, settings) : [];
}

/**
 * Distance from an interior point to the nearest edge of the ring, given up as soon as it
 * is known to exceed `limit` — which is the ramp width, and is far smaller than a typical
 * polygon. That bound is what makes this affordable at the rate the physics asks for it:
 * a segment whose bounding box is already further away than the best distance so far is
 * rejected in four comparisons, so the deep interior of a 400-vertex wood costs four
 * comparisons per segment. The whole loop runs on squared distances and takes its one
 * square root at the end.
 */
export function distanceToRing(ring: readonly LocalPoint[], x: number, z: number, limit: number): number {
  let best = limit;
  let bestSquared = limit * limit;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[previous];
    const b = ring[index];
    if (Math.min(a.x, b.x) - x >= best || x - Math.max(a.x, b.x) >= best) continue;
    if (Math.min(a.z, b.z) - z >= best || z - Math.max(a.z, b.z) >= best) continue;
    const squared = pointSegmentDistanceSquared(x, z, a, b);
    if (squared < bestSquared) {
      bestSquared = squared;
      best = Math.sqrt(squared);
    }
  }
  return best;
}

/**
 * The shape of the bank in profile, over 0..1 of the ramp. Smoothstep rather than a
 * straight line: it leaves the ground plane and meets the flat top with zero gradient, so
 * a car crossing either end of the slope is not hit with an instantaneous change in the
 * surface it is standing on. A linear ramp puts a crease at both ends, and a crease is
 * exactly the kind of discontinuity a suspension damper amplifies into a bang.
 */
export function terrainRampProfile(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Height of the terrain under a point, or 0 where it stands on the base ground plane. The
 * single answer to "what is the ground level here" — roads sit above it, trees stand on
 * it, wheels roll on it.
 *
 * The bounding box is a cheap reject; the ring test is what stops a road from climbing
 * because it clipped the *corner* of a large, irregular wood it never actually enters.
 * That over-approximation was the loudest source of unexplained metre-scale steps in the
 * world: a single L-shaped forest polygon could lift every street inside its bounding
 * box, none of which were in the wood at all.
 */
/** Shared scan body for both the plain-array and indexed lookups: walks whatever
 * iterable of candidate bounds it is given and returns the tallest one that actually
 * contains (x, z). Kept as one function so the ramp/containment logic — and its ordering,
 * which matters for the early-out below — never drifts between the two call paths. */
function tallestClearanceAt(x: number, z: number, candidates: Iterable<TerrainClearance>): number {
  let height = 0;
  for (const bounds of candidates) {
    if (x < bounds.minX || x > bounds.maxX) continue;
    if (z < bounds.minZ || z > bounds.maxZ) continue;
    // A ramped polygon can never exceed its own full height, so a taller answer already
    // in hand makes the whole polygon — ring test included — skippable.
    if (bounds.height <= height) continue;
    _probe.x = x;
    _probe.z = z;
    if (!pointInRing(_probe, bounds.ring)) continue;
    const candidate = bounds.ramp > 0
      ? bounds.height * terrainRampProfile(distanceToRing(bounds.ring, x, z, bounds.ramp) / bounds.ramp)
      : bounds.height;
    if (candidate > height) height = candidate;
  }
  return height;
}

export function terrainHeightAtXZ(x: number, z: number, terrain: TerrainClearance[]): number {
  return tallestClearanceAt(x, z, terrain);
}

/** Point-shaped convenience over terrainHeightAtXZ, for the callers that already hold a
 * LocalPoint. The physics ground calls the coordinate form directly — it asks a couple of
 * hundred times a tick, and a literal per query is a literal per query. */
export function terrainHeightAt(point: LocalPoint, terrain: TerrainClearance[]): number {
  return terrainHeightAtXZ(point.x, point.z, terrain);
}

const _probe: LocalPoint = { x: 0, z: 0 };

/**
 * Uniform grid over `terrain`'s polygons, built once per snapshot and queried many times
 * (backlog item 3: "spatial indexes for terrain"). `terrainHeightAtXZ` is a full linear
 * scan of every polygon in range regardless of where (x, z) actually is, and it is called
 * per road point, per tree/object placement during a world build, and per physics tick at
 * runtime — hundreds to tens of thousands of calls against an array that can hold roughly
 * a thousand park/landuse polygons. A polygon is filed into every cell its bounding box
 * overlaps, so a query only rescans the polygons whose box could plausibly contain the
 * point, not the whole set. `cellSize` of 40m keeps most park/landuse polygons (rarely
 * larger than a city block) inside one or a small handful of cells.
 */
export interface TerrainIndex {
  cellSize: number;
  /**
   * Buckets keyed by a flat integer cell id rather than a `"cx,cz"` string. The physics
   * ground asks a couple of hundred of these per tick and a world build tens of
   * thousands, and a string key means allocating (and hashing) a fresh string on every
   * one of them — garbage produced at frame rate, for a number that was already a
   * number. spatialGrid.ts made the same call for the same reason; this is that key
   * scheme, not a second one.
   */
  cells: Map<number, TerrainClearance[]>;
  /** Cell coordinates of the index's own extent, and the row stride keys are built from.
   * A query outside this range cannot hit any polygon, and — because a flat key wraps
   * rows into each other — must not be allowed to build a key at all: `(cx: -1, cz: 1)`
   * and `(cx: columns - 1, cz: 0)` would otherwise share one bucket and report a polygon
   * a kilometre away as underfoot. Range-checking first is both the correctness guard
   * and the fastest possible answer for the many queries that land off the data. */
  minCellX: number;
  minCellZ: number;
  columns: number;
  rows: number;
  /** Polygons whose bounding box spans more cells than `MAX_CELLS_PER_POLYGON`, checked
   * against every query instead of being copied into thousands of buckets. A single
   * district-sized landuse polygon (they exist: residential blankets whole street grids)
   * would otherwise cost more to file than the linear scan this index replaces. */
  everywhere: TerrainClearance[];
}

const TERRAIN_INDEX_DEFAULT_CELL_SIZE = 40;

/** See `TerrainIndex.everywhere`. 48 cells is ~a 280m square at the default cell size —
 * larger than any park or landuse polygon that benefits from being filed at all. */
const MAX_CELLS_PER_POLYGON = 48;

/** A polygon with a non-finite bound cannot be filed: `Math.floor(Infinity)` is
 * `Infinity`, and the fill loop below would never terminate. `computeTerrainClearance`
 * already drops these, so this is a guard against a hand-built profile rather than a
 * case the world produces. */
function hasFiniteBounds(bounds: TerrainClearance): boolean {
  return Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.minZ) && Number.isFinite(bounds.maxZ);
}

export function buildTerrainIndex(
  terrain: readonly TerrainClearance[],
  cellSize = TERRAIN_INDEX_DEFAULT_CELL_SIZE,
): TerrainIndex {
  const cells = new Map<number, TerrainClearance[]>();
  const everywhere: TerrainClearance[] = [];

  // First pass fixes the extent, so the second can key every cell off one origin.
  let minCellX = 0;
  let minCellZ = 0;
  let maxCellX = -1;
  let maxCellZ = -1;
  let first = true;
  for (const bounds of terrain) {
    if (!hasFiniteBounds(bounds)) continue;
    const loX = Math.floor(bounds.minX / cellSize);
    const hiX = Math.floor(bounds.maxX / cellSize);
    const loZ = Math.floor(bounds.minZ / cellSize);
    const hiZ = Math.floor(bounds.maxZ / cellSize);
    if (first) {
      minCellX = loX; maxCellX = hiX; minCellZ = loZ; maxCellZ = hiZ;
      first = false;
      continue;
    }
    if (loX < minCellX) minCellX = loX;
    if (hiX > maxCellX) maxCellX = hiX;
    if (loZ < minCellZ) minCellZ = loZ;
    if (hiZ > maxCellZ) maxCellZ = hiZ;
  }

  const columns = Math.max(0, maxCellX - minCellX + 1);
  const rows = Math.max(0, maxCellZ - minCellZ + 1);
  const keyAt = (cx: number, cz: number) => (cz - minCellZ) * columns + (cx - minCellX);

  for (const bounds of terrain) {
    if (!hasFiniteBounds(bounds)) continue;
    const loX = Math.floor(bounds.minX / cellSize);
    const hiX = Math.floor(bounds.maxX / cellSize);
    const loZ = Math.floor(bounds.minZ / cellSize);
    const hiZ = Math.floor(bounds.maxZ / cellSize);
    if ((hiX - loX + 1) * (hiZ - loZ + 1) > MAX_CELLS_PER_POLYGON) {
      everywhere.push(bounds);
      continue;
    }
    for (let cz = loZ; cz <= hiZ; cz += 1) {
      for (let cx = loX; cx <= hiX; cx += 1) {
        const key = keyAt(cx, cz);
        const bucket = cells.get(key);
        if (bucket) bucket.push(bounds);
        else cells.set(key, [bounds]);
      }
    }
  }

  return { cellSize, cells, minCellX, minCellZ, columns, rows, everywhere };
}

/**
 * Candidate polygons whose bounding box could cover `(x, z)`: the query cell's own
 * bucket plus the oversized polygons that were never filed. Exported so a caller (and
 * the index's own regression test) can measure how much of the set a query actually
 * rescans without depending on how a cell key is built.
 */
export function terrainIndexCandidatesAt(
  x: number,
  z: number,
  index: TerrainIndex,
): readonly TerrainClearance[] {
  const cx = Math.floor(x / index.cellSize) - index.minCellX;
  const cz = Math.floor(z / index.cellSize) - index.minCellZ;
  if (cx < 0 || cx >= index.columns || cz < 0 || cz >= index.rows) return index.everywhere;
  const bucket = index.cells.get(cz * index.columns + cx);
  if (!bucket) return index.everywhere;
  if (index.everywhere.length === 0) return bucket;
  return [...bucket, ...index.everywhere];
}

/** Indexed equivalent of `terrainHeightAtXZ`. Returns 0 (bare ground) for a query cell
 * that holds no polygon at all, without touching the rest of the set. */
export function terrainHeightAtXZIndexed(x: number, z: number, index: TerrainIndex): number {
  const cx = Math.floor(x / index.cellSize) - index.minCellX;
  const cz = Math.floor(z / index.cellSize) - index.minCellZ;
  // Off the index entirely: only an unfileable polygon can still be underfoot. Skipping
  // the map lookup here is what makes a query outside the built world nearly free.
  if (cx < 0 || cx >= index.columns || cz < 0 || cz >= index.rows) {
    return index.everywhere.length === 0 ? 0 : tallestClearanceAt(x, z, index.everywhere);
  }
  const bucket = index.cells.get(cz * index.columns + cx);
  const height = bucket ? tallestClearanceAt(x, z, bucket) : 0;
  if (index.everywhere.length === 0) return height;
  return Math.max(height, tallestClearanceAt(x, z, index.everywhere));
}

/** Point-shaped convenience over `terrainHeightAtXZIndexed`, mirroring `terrainHeightAt`. */
export function terrainHeightAtIndexed(point: LocalPoint, index: TerrainIndex): number {
  return terrainHeightAtXZIndexed(point.x, point.z, index);
}

/** How far above the shared ground datum a water surface sits — enough to clear the
 * ground plane's own z-fighting jitter band, never so much a pond inside a mound reads
 * as floating above its banks. */
export const WATER_SURFACE_EPSILON = 0.02;

/**
 * Water height, tied to the same shared surface datum as everything else that needs "the
 * ground here" (roads, trees, the physics floor) instead of a fixed absolute constant.
 *
 * Before this, water polygons sat at a hard-coded y regardless of the terrain underneath
 * them, so a pond that happened to fall inside or beside a landuse mound either floated
 * over its bank or was buried under it (see docs/TODO.md's "Water polygons are not cut
 * into the terrain"), and re-streaming a chunk with a different `terrainIndex` snapshot
 * could shift the water plane relative to its own shoreline. Sampling the *ring's own
 * vertices* (not just its centroid) and taking the tallest ground under any of them means
 * the water surface always clears the terrain it borders, however that terrain is
 * currently mounded — and is a pure function of `index`, so the same input world data
 * always yields the same water height.
 */
export function waterSurfaceHeightAtIndexed(ring: readonly LocalPoint[], index: TerrainIndex): number {
  let ground = 0;
  for (const point of ring) {
    const height = terrainHeightAtXZIndexed(point.x, point.z, index);
    if (height > ground) ground = height;
  }
  return ground + WATER_SURFACE_EPSILON;
}

/**
 * +1 if the ring's vertices run one way round in the xz plane, -1 if the other. OSM rings
 * arrive both ways, and everything that has to know which side of an edge is "in" — the
 * inward offset here, the triangle winding of the mound built on it — needs the same
 * answer, so there is one function that gives it.
 */
export function ringWinding(ring: readonly LocalPoint[]): 1 | -1 {
  let twiceArea = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    twiceArea += ring[previous].x * ring[index].z - ring[index].x * ring[previous].z;
  }
  return twiceArea >= 0 ? 1 : -1;
}

/**
 * Inward offset of a ring by `distance`, as the top face of a mound sitting on it.
 *
 * Per-vertex miter: each corner moves along the bisector of its two edge normals, far
 * enough that both offset edges stay parallel to the originals. The miter is clamped at
 * four times the offset so a needle-sharp corner produces a blunted top rather than a
 * spike thrown halfway across the polygon — the standard failure of naive offsetting, and
 * the only one that shows up on real OSM rings.
 */
export function insetRing(ring: LocalPoint[], distance: number): LocalPoint[] {
  if (!(distance > 0) || ring.length < 3) return ring;
  const winding = ringWinding(ring);
  const inNormal = (a: LocalPoint, b: LocalPoint): LocalPoint => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: (-dz / length) * winding, z: (dx / length) * winding };
  };
  const inset: LocalPoint[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const previous = ring[(index - 1 + ring.length) % ring.length];
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const first = inNormal(previous, current);
    const second = inNormal(current, next);
    let bisectorX = first.x + second.x;
    let bisectorZ = first.z + second.z;
    const length = Math.hypot(bisectorX, bisectorZ);
    if (length < 1e-6) {
      inset.push({ x: current.x + first.x * distance, z: current.z + first.z * distance });
      continue;
    }
    bisectorX /= length;
    bisectorZ /= length;
    const projection = bisectorX * first.x + bisectorZ * first.z;
    const miter = Math.min(distance / Math.max(projection, 0.25), distance * 4);
    inset.push({ x: current.x + bisectorX * miter, z: current.z + bisectorZ * miter });
  }
  return inset;
}
