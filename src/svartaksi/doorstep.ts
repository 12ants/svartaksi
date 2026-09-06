import type { FacadeDoorRecord } from './doorPlacement';
import type { SvartaksiFacadeWall } from '../world/facadeRecords';
import type { LocalPoint, WorldArea, WorldBuilding } from '../world/types';
import { boundsOfPoints, memoizedSpatialGrid } from '../world/spatialGrid';
import { pointInRing } from './randomSpawn';

/**
 * Side of one cell in the two grids below, in meters. A doorstep is under a metre deep
 * and a couple of metres wide, so every query here is effectively a point — the cell only
 * has to be small enough that a bucket holds a block's worth of footprints rather than a
 * district's.
 */
const DOORSTEP_CELL_METERS = 40;

/**
 * The world's footprints and water bodies, filed by area.
 *
 * A doorstep is refused if it overlaps any other building or any water, and this runs
 * once per door on every building in the snapshot — ~1 500 of them, each previously
 * tested against all ~1 500 footprints and every water polygon with a full
 * polygon-overlap test. That product was several seconds of a world build; over a grid it
 * is a handful of comparisons per door, for the same answers. See spatialGrid.ts.
 */
const buildingGrid = memoizedSpatialGrid<WorldBuilding[], WorldBuilding>(
  (buildings) => buildings,
  (building) => boundsOfPoints(building.rings.flat()),
  { cellMeters: DOORSTEP_CELL_METERS },
);

const waterGrid = memoizedSpatialGrid<WorldArea[], WorldArea>(
  (water) => water,
  (area) => boundsOfPoints(area.rings.flat()),
  { cellMeters: DOORSTEP_CELL_METERS },
);

export interface DoorstepRecord {
  center: LocalPoint;
  yaw: number;
  width: number;
  depth: number;
  height: number;
  kind: 'step' | 'landing' | 'hardstanding';
}

export function resolveDoorstep(input: {
  wall: SvartaksiFacadeWall;
  door: FacadeDoorRecord;
  building: WorldBuilding;
  allBuildings: WorldBuilding[];
  water: WorldArea[];
}): DoorstepRecord | null {
  const { wall, door } = input;
  if (wall.width < door.width + 0.6 || door.width <= 0) return null;

  const kind = doorstepKind(input.building);
  const width = Math.min(door.width + (kind === 'landing' ? 0.8 : 0.6), wall.width - 0.2);
  const depth = kind === 'landing' ? 0.85 : kind === 'hardstanding' ? 0.8 : 0.65;
  const height = kind === 'step' ? 0.16 : 0.08;
  const alongX = Math.cos(wall.yaw);
  const alongZ = Math.sin(wall.yaw);
  const doorOffset = door.centerX - wall.width / 2;
  const wallPoint = {
    x: wall.centerX + alongX * doorOffset,
    z: wall.centerZ + alongZ * doorOffset,
  };
  const center = {
    x: wallPoint.x + wall.outwardX * depth / 2,
    z: wallPoint.z + wall.outwardZ * depth / 2,
  };
  const footprint = rectangleCorners(center, alongX, alongZ, wall.outwardX, wall.outwardZ, width, depth);

  // Only polygons whose own bounding box reaches this step can overlap it, so the query
  // is the step's own box — nothing outside it is a candidate.
  const footprintBox = boundsOfPoints(footprint);
  if (!footprintBox) return null;
  if (waterGrid(input.water).anyNear(footprintBox, area =>
    area.rings.some(ring => polygonsOverlap(footprint, ring)))) return null;
  if (buildingGrid(input.allBuildings).anyNear(footprintBox, candidate =>
    candidate.id !== input.building.id
    && candidate.rings.some(ring => polygonsOverlap(footprint, ring)))) return null;

  const parentRing = input.building.rings[0];
  if (!parentRing || footprint.slice(2).some(corner => pointInRing(corner, parentRing))) return null;

  return { center, yaw: wall.yaw, width, depth, height, kind };
}

function doorstepKind(building: WorldBuilding): DoorstepRecord['kind'] {
  const use = [
    building.appearance?.buildingKind,
    building.appearance?.buildingUse,
    building.properties.building,
    building.properties['building:use'],
    building.properties.shop,
    building.properties.amenity,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/industrial|warehouse|service|storage/.test(use)) return 'hardstanding';
  if (/shop|store|retail|civic|office|public|commercial/.test(use)) return 'landing';
  return 'step';
}

function rectangleCorners(
  center: LocalPoint,
  alongX: number,
  alongZ: number,
  outwardX: number,
  outwardZ: number,
  width: number,
  depth: number,
): LocalPoint[] {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  return [
    { x: center.x - alongX * halfWidth - outwardX * halfDepth, z: center.z - alongZ * halfWidth - outwardZ * halfDepth },
    { x: center.x + alongX * halfWidth - outwardX * halfDepth, z: center.z + alongZ * halfWidth - outwardZ * halfDepth },
    { x: center.x + alongX * halfWidth + outwardX * halfDepth, z: center.z + alongZ * halfWidth + outwardZ * halfDepth },
    { x: center.x - alongX * halfWidth + outwardX * halfDepth, z: center.z - alongZ * halfWidth + outwardZ * halfDepth },
  ];
}

function polygonsOverlap(a: LocalPoint[], b: LocalPoint[]): boolean {
  if (a.some(point => pointInRing(point, b)) || b.some(point => pointInRing(point, a))) return true;
  return a.some((start, index) => {
    const end = a[(index + 1) % a.length];
    return b.some((otherStart, otherIndex) =>
      segmentsIntersect(start, end, otherStart, b[(otherIndex + 1) % b.length]));
  });
}

function segmentsIntersect(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  );
}

function cross(a: LocalPoint, b: LocalPoint, c: LocalPoint): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}
