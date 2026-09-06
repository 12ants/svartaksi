/**
 * "Is this point in water, and how high is the surface there?" — the query the swimming
 * pill and the sinking car are driven from.
 *
 * `waterSurfaceHeightAtIndexed` (terrain.ts) already answers what height *one water
 * polygon's* sheet is drawn at, and that is the number this index stores: rendering and
 * gameplay must agree about where the surface is, or the pill floats at a height the
 * water is not actually drawn at. What is new here is the reverse lookup — from a point
 * to whichever polygon contains it — which nothing needed while water was only ever
 * drawn.
 *
 * It has to be cheap: the car asks five times per fixed tick (centre plus four wheels)
 * and the pill once, against a snapshot that can hold hundreds of water polygons, one of
 * which is usually the whole Baltic. So the polygons are filed into the shared spatial
 * grid and only the handful whose bounding box covers the point are ring-tested.
 */
import { pointInRing } from './geo';
import { boundsOfPoints, createSpatialGrid, type Bounds, type SpatialGrid } from './spatialGrid';
import {
  buildTerrainIndex,
  distanceToRing,
  terrainRampProfile,
  waterSurfaceHeightAtIndexed,
  type TerrainIndex,
} from './terrain';
import type { LocalPoint, WorldArea } from './types';

interface WaterBody {
  outer: LocalPoint[];
  /** Islands. A ring inside the outer ring is land, and standing on one is not swimming. */
  holes: LocalPoint[][];
  bounds: Bounds;
  /** The height this polygon's sheet is drawn at, resolved once at build time from the
   * same shared surface datum the renderer uses. */
  surfaceY: number;
}

export interface WaterIndex {
  grid: SpatialGrid<WaterBody>;
  /** Number of polygons filed, for diagnostics and for the empty-world early-out. */
  count: number;
}

/**
 * Cell size, in meters. Sized for the *queries* (a point) rather than the items, so it
 * only wants to be small enough that a bucket holds few polygons; a bay and a lake in the
 * same 64m cell is already a two-item bucket.
 */
const WATER_CELL_METERS = 64;

export function buildWaterIndex(water: readonly WorldArea[], terrain: TerrainIndex): WaterIndex {
  const bodies: WaterBody[] = [];
  for (const area of water) {
    const outer = area.rings[0];
    if (!outer || outer.length < 3) continue;
    const bounds = boundsOfPoints(outer);
    if (!bounds) continue;
    bodies.push({
      outer,
      holes: area.rings.slice(1).filter((ring) => ring.length >= 3),
      bounds,
      surfaceY: waterSurfaceHeightAtIndexed(outer, terrain),
    });
  }
  return {
    grid: createSpatialGrid(bodies, (body) => body.bounds, { cellMeters: WATER_CELL_METERS }),
    count: bodies.length,
  };
}

/**
 * How deep open water is taken to be, and how far in from the shore it takes to get there.
 *
 * There is no bathymetry in the source and no elevation model at all in this world (see
 * the flat-world note in README/AGENTS), so a water polygon is drawn as a sheet two
 * centimetres over the same flat ground everything else stands on. Taken literally that
 * means every lake in Stockholm is ankle-deep: nothing could ever swim, and nothing could
 * ever sink.
 *
 * So depth is *derived from what the map does say*, exactly the way terrain.ts derives
 * relief from land use: a point is as deep as it is far from the nearest shore, shelving
 * from nothing at the boundary to `WATER_OPEN_DEPTH` a shelf-width in. It is not real
 * Stockholm bathymetry and does not pretend to be; it is a legible, consistent bed that
 * follows the one thing the data actually states, which is where the water ends.
 *
 * The shelf is what makes a shoreline a place you wade across rather than a line you fall
 * off, and it uses `terrainRampProfile` — the same smoothstep a landuse bank does — so it
 * leaves the shore and reaches open water with zero gradient at both ends.
 */
export const WATER_OPEN_DEPTH = 3.2;
export const WATER_SHELF_WIDTH = 7;

export interface WaterSample {
  /** World Y the sheet is drawn at. */
  surface: number;
  /** Metres of water over the implied bed at this point. */
  depth: number;
}

/** Reused across queries: this runs several times per fixed tick, and a fresh literal per
 * sample is a fresh literal per sample. Same reasoning as terrain.ts's own `_probe`. */
const _probe: LocalPoint = { x: 0, z: 0 };
const _point: Bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

/**
 * The water surface height at (x, z), or null where no water polygon covers the point at
 * all — which is exactly the shore-exit condition `isAtShore` tests for.
 *
 * Overlapping polygons (a bay drawn over the sea it opens into is the common case) resolve
 * to the *highest* surface: that is the sheet actually drawn on top at that point, so it is
 * the one a pill floats on.
 */
export function waterHeightAtXZ(x: number, z: number, index: WaterIndex): number | null {
  if (index.count === 0) return null;
  _point.minX = x;
  _point.maxX = x;
  _point.minZ = z;
  _point.maxZ = z;
  _probe.x = x;
  _probe.z = z;
  let height: number | null = null;
  index.grid.forEachNear(_point, (body) => {
    // The grid visits a polygon once per cell its box covers, so a bounds reject here is
    // both the cheap early-out and what keeps a repeat visit from re-running the ring test.
    if (x < body.bounds.minX || x > body.bounds.maxX) return;
    if (z < body.bounds.minZ || z > body.bounds.maxZ) return;
    if (height !== null && body.surfaceY <= height) return;
    if (!pointInRing(_probe, body.outer)) return;
    for (const hole of body.holes) if (pointInRing(_probe, hole)) return;
    height = body.surfaceY;
  });
  return height;
}

/**
 * The surface *and* the implied depth at (x, z), or null outside every water polygon.
 *
 * Split from `waterHeightAtXZ` rather than folded into it because the distance-to-shore
 * walk is the expensive half and only one caller needs it: the swimming body asks this
 * once a tick, while the car's five footprint samples only need to know how deep the water
 * is, which `waterDepthAtXZ` answers without the surface.
 */
export function waterSampleAtXZ(x: number, z: number, index: WaterIndex): WaterSample | null {
  if (index.count === 0) return null;
  _point.minX = x;
  _point.maxX = x;
  _point.minZ = z;
  _point.maxZ = z;
  _probe.x = x;
  _probe.z = z;
  let found: WaterSample | null = null;
  index.grid.forEachNear(_point, (body) => {
    if (x < body.bounds.minX || x > body.bounds.maxX) return;
    if (z < body.bounds.minZ || z > body.bounds.maxZ) return;
    if (found !== null && body.surfaceY <= found.surface) return;
    if (!pointInRing(_probe, body.outer)) return;
    for (const hole of body.holes) if (pointInRing(_probe, hole)) return;
    // An island's own edge shelves the same way the outer shore does — swimming up to a
    // holm should shallow out, not end at a wall — so the nearest of every ring counts.
    let toShore = distanceToRing(body.outer, x, z, WATER_SHELF_WIDTH);
    for (const hole of body.holes) {
      toShore = Math.min(toShore, distanceToRing(hole, x, z, WATER_SHELF_WIDTH));
    }
    found = {
      surface: body.surfaceY,
      depth: WATER_OPEN_DEPTH * terrainRampProfile(toShore / WATER_SHELF_WIDTH),
    };
  });
  return found;
}

/** Just the depth, for the car's footprint samples: a car is in the water when the water
 * is deeper than its floorpan, which is a question about depth and not about height. */
export function waterDepthAtXZ(x: number, z: number, index: WaterIndex): number | null {
  return waterSampleAtXZ(x, z, index)?.depth ?? null;
}

/** The empty index a runtime holds before its first world snapshot arrives. Every query
 * against it returns null, so the terrain it is handed is never read. */
export function emptyWaterIndex(): WaterIndex {
  return buildWaterIndex([], buildTerrainIndex([]));
}
