/**
 * Shared "is this point actually clear of every road's paved surface" check, used to
 * reject a lamp or traffic-signal placement that a single road's own offset math
 * missed — typically a second road running close and roughly parallel, a road curving
 * through the offset point, or a multi-way junction with more approaches than the
 * two-axis model accounts for.
 *
 * Every procedural placement in the world runs through here — lamp posts, shelters, post
 * boxes — and each of them offers a candidate every few tens of meters along every road
 * it was given. Answering each of those by walking the whole road network and every
 * building footprint is a product of two large numbers: the opening snapshot has
 * ~10 800 roads and ~9 800 buildings, and `generateStreetLights` alone offers it tens of
 * thousands of candidates. That was measured at 14 seconds inside a *single* build
 * slice — the one part of the first load that no amount of slicing could break up, and
 * the larger part of the game freezing on "Assembling streets, water and rooftops".
 *
 * So both sets go through a spatial grid (see spatialGrid.ts), built once per array and
 * reused for every later question about it. The answers are identical; only the number of
 * candidates examined changes.
 */
import { pointInRing } from './geo';
import { boundsOfPoints, memoizedSpatialGrid } from './spatialGrid';
import type { LocalPoint, WorldBuilding, WorldRoad } from './types';

function pointSegmentDistance(x: number, z: number, a: LocalPoint, b: LocalPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1,
    ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

/**
 * Side of one grid cell for both grids below, in meters. Roughly a city block: a query is
 * a point plus a road's half-width, so a cell this size is visited a handful at a time,
 * while a smoothed road segment (whose points are meters apart, not hundreds) still lands
 * in one or two cells rather than being copied across a row of them.
 */
const CLEARANCE_CELL_METERS = 40;

interface RoadSegment {
  a: LocalPoint;
  b: LocalPoint;
  /** Half the owning road's paved width — how far this segment covers, before the
   * caller's own margin is added. */
  halfWidth: number;
}

/**
 * How far a road-clearance query reaches beyond the caller's margin, in meters.
 *
 * A segment covers a point out to its own half-width, so the query box has to be at least
 * the widest half-width in the world — otherwise a wide motorway filed in the next cell
 * over would be missed. `widths` in the MapLibre provider tops out at 18 meters (motorway),
 * so 12 is comfortably clear of it, and a road wider than that would have to be a data
 * error.
 */
const MAX_ROAD_HALF_WIDTH = 12;

const roadSegmentGrid = memoizedSpatialGrid<WorldRoad[], RoadSegment>(
  (roads) => {
    const segments: RoadSegment[] = [];
    for (const road of roads) {
      const halfWidth = road.width / 2;
      const points = road.points;
      for (let index = 0; index < points.length - 1; index += 1) {
        segments.push({ a: points[index], b: points[index + 1], halfWidth });
      }
    }
    return segments;
  },
  (segment) => boundsOfPoints([segment.a, segment.b]),
  { cellMeters: CLEARANCE_CELL_METERS },
);

const buildingFootprintGrid = memoizedSpatialGrid<WorldBuilding[], WorldBuilding>(
  (buildings) => buildings,
  (building) => boundsOfPoints(building.rings[0] ?? []),
  { cellMeters: CLEARANCE_CELL_METERS },
);

/** True if `(x, z)` falls within any road's own paved half-width, plus `margin`. */
export function isPointOnAnyRoad(x: number, z: number, roads: WorldRoad[], margin: number): boolean {
  // Reach out by the widest possible half-width plus the margin: any segment that could
  // still cover this point has a bounding box inside that box, so it is filed in one of
  // the cells the box touches.
  const reach = margin + MAX_ROAD_HALF_WIDTH;
  const box = { minX: x - reach, maxX: x + reach, minZ: z - reach, maxZ: z + reach };
  return roadSegmentGrid(roads).anyNear(box, (segment) => {
    const clearance = segment.halfWidth + margin;
    const { a, b } = segment;
    // Cheap bounding-box reject before the real point-segment distance.
    if (Math.min(a.x, b.x) - x > clearance || x - Math.max(a.x, b.x) > clearance) return false;
    if (Math.min(a.z, b.z) - z > clearance || z - Math.max(a.z, b.z) > clearance) return false;
    return pointSegmentDistance(x, z, a, b) < clearance;
  });
}

function isInsideAnyBuilding(x: number, z: number, buildings: WorldBuilding[]): boolean {
  // A footprint containing the point has a bounding box containing it too, so the single
  // cell the point falls in holds every candidate.
  const box = { minX: x, maxX: x, minZ: z, maxZ: z };
  return buildingFootprintGrid(buildings).anyNear(box, (building) => {
    const ring = building.rings[0];
    return Boolean(ring && pointInRing({ x, z }, ring));
  });
}

/**
 * The one "is this spot actually free to plant street furniture on" check, shared by
 * every kind of procedurally-placed furniture (lamps, shelters, post boxes) instead of
 * each rolling its own subset of these same tests. Rejects a point that lands on any
 * road's own paved surface, inside any building's footprint (a lamp standing in a
 * building's own outline is the previous placements' one shared blind spot — none of
 * them checked buildings at all), or within `minSpacing` of an already-placed item —
 * that last check is skipped entirely when `minSpacing` is 0, since most callers here
 * have no spacing rule of their own and don't want an empty `otherPlacements` list's
 * scan cost either.
 */
export function isPavementClear(
  x: number,
  z: number,
  roads: WorldRoad[],
  roadMargin: number,
  buildings: WorldBuilding[] = [],
  otherPlacements: readonly { x: number; z: number }[] = [],
  minSpacing = 0,
): boolean {
  if (isPointOnAnyRoad(x, z, roads, roadMargin)) return false;
  if (buildings.length && isInsideAnyBuilding(x, z, buildings)) return false;
  if (minSpacing > 0) {
    for (const other of otherPlacements) {
      if (Math.hypot(x - other.x, z - other.z) < minSpacing) return false;
    }
  }
  return true;
}
