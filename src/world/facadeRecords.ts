/** Turns a WorldBuilding polygon into per-wall facade records (profile, layout, door) ready for facadeRenderer to instance. */
import {
  resolveFacadeProfile,
  type FacadeFamily,
  type FacadeProfile,
} from '../svartaksi/buildingFacade';
import {
  glassPaneForDoor,
  selectBuildingDoors,
  type DoorOutcome,
  type DoorWallCandidate,
  type FacadeDoorRecord,
} from '../svartaksi/doorPlacement';
import { solveFacadeLayout, type FacadeLayout } from '../svartaksi/facadeLayout';
import { classifyFacadeArea } from '../svartaksi/facadePalette';
import { resolveDoorStyle } from '../svartaksi/doorStyle';
import { resolveDoorstep, type DoorstepRecord } from '../svartaksi/doorstep';
import type { LocalPoint, WorldArea, WorldBuilding } from './types';
import type { WorldInspectionRecord } from './inspection';

export interface SvartaksiFacadeWall {
  centerX: number;
  centerY: number;
  centerZ: number;
  width: number;
  height: number;
  yaw: number;
  outwardX: number;
  outwardZ: number;
  profileKey: string;
  family: FacadeFamily;
  variant: number;
  profile: FacadeProfile;
  layout: FacadeLayout;
  seed: number;
  door?: FacadeDoorRecord;
  doorstep?: DoorstepRecord;
  inspection?: WorldInspectionRecord;
}

export interface SvartaksiFacadeBuilding {
  id: string;
  centerX: number;
  centerZ: number;
  walls: SvartaksiFacadeWall[];
  doorOutcome: DoorOutcome;
}

interface FootprintEdge {
  start: LocalPoint;
  end: LocalPoint;
  width: number;
}

export function buildFacadeRecord(
  building: WorldBuilding,
  context?: { buildings: WorldBuilding[]; water: WorldArea[]; baseY?: number },
): SvartaksiFacadeBuilding | null {
  const baseY = context?.baseY ?? 0;
  if (!Number.isFinite(building.height) || building.height <= 0) return null;
  const raw = normalizeFootprint(building.rings[0]);
  if (!raw) return null;
  const footprint = describeFootprint(raw);
  if (!footprint) return null;
  const points = orientFootprint(raw, footprint.winding);
  const edges = extractEdges(points);
  if (!edges) return null;
  const propertyDetails = Object.entries(building.properties)
    .map(([key, value]) => `${key}=${String(value)}`);
  const areaKind = classifyFacadeArea(String(building.properties.name ?? ''), propertyDetails);
  const resolved = resolveFacadeProfile({
    ...building.properties,
    ...(building.appearance ?? {}),
    'building:colour': building.appearance?.wallColor ?? building.properties['building:colour'],
    height: building.height,
  }, {
    identity: building.id,
    // A frozen seed string, not a place name. It is hashed with the building's own id to
    // pick that building's facade variant (stableFacadeVariant), so changing it repaints
    // every building in the city — and, because facades batch by profile, changes how many
    // draw calls the skyline costs. Keep it as it is unless a re-roll of the whole city's
    // appearance is the actual intent.
    areaId: 'nacka-world',
    areaKind,
    colorScheme: 'stockholm-dusk',
  });
  if (building.height <= 15 && resolved.family === 'residential') {
    resolved.profile = {
      ...resolved.profile,
      // Shorter than the standard 4.0m ground floor, so small houses still fit a
      // window row near the ground. This can put row 0 at door height, but the
      // fragment shader now drops any window cell that overlaps the door's own
      // rectangle instead of requiring the whole floor to clear it — so the house
      // keeps its other ground-floor windows and just skips the one over the door.
      firstFloorHeight: 1.05,
      roofPadding: Math.min(resolved.profile.roofPadding, 0.55),
      windowHeight: Math.min(resolved.profile.windowHeight, 1.35),
    };
  }
  const walls = edges.map((edge, edgeIndex) => {
    const layout = solveFacadeLayout(edge.width, building.height, resolved.profile) ?? {
      columns: 0, rows: 0, startX: edge.width / 2, startY: building.height / 2,
      endX: edge.width / 2, endY: building.height / 2,
    };
    return createWall(edge, edgeIndex, building, resolved, layout, baseY);
  });

  const selection = selectBuildingDoors({
    walls: walls.map(toDoorCandidate),
    entrances: (building.entrances ?? []).map((entrance, index) => ({
      id: `entrance:${index}`,
      x: entrance.point.x,
      y: entrance.point.z,
    })),
    detail: 'balanced',
  });
  for (const door of selection.doors) {
    const { wallIndex, ...record } = door;
    const entranceIndex = Number(door.entranceId?.split(':')[1]);
    const entranceTags = Number.isInteger(entranceIndex)
      ? building.entrances?.[entranceIndex]?.tags ?? {}
      : {};
    const style = resolveDoorStyle({
      building,
      family: walls[wallIndex].family,
      entranceTags,
      seed: walls[wallIndex].seed,
    });
    walls[wallIndex].door = {
      ...record,
      style,
      glass: style.glassRatio > 0.2
        ? glassPaneForDoor(Math.min(walls[wallIndex].seed, 0.44), record)
        : undefined,
    };
    if (context) {
      walls[wallIndex].doorstep = resolveDoorstep({
        wall: walls[wallIndex],
        door: walls[wallIndex].door,
        building,
        allBuildings: context.buildings,
        water: context.water,
      }) ?? undefined;
    }
  }
  return { id: building.id, centerX: footprint.center.x, centerZ: footprint.center.z, walls, doorOutcome: selection.outcome };
}

function normalizeFootprint(ring: LocalPoint[] | undefined): LocalPoint[] | null {
  if (!ring || ring.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.z))) {
    return null;
  }
  const points = [...ring];
  const first = points[0];
  const last = points.at(-1);
  if (points.length > 1 && first.x === last?.x && first.z === last.z) points.pop();
  return points.length >= 3 ? points : null;
}

function extractEdges(points: LocalPoint[]): FootprintEdge[] | null {
  const edges = points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    return { start, end, width: Math.hypot(end.x - start.x, end.z - start.z) };
  });
  return edges.some(edge => !Number.isFinite(edge.width) || edge.width === 0) ? null : edges;
}

function describeFootprint(points: LocalPoint[]): { center: LocalPoint; winding: 1 | -1 } | null {
  let twiceArea = 0;
  let absoluteCrossSum = 0;
  let weightedX = 0;
  let weightedZ = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const cross = point.x * next.z - next.x * point.z;
    twiceArea += cross;
    absoluteCrossSum += Math.abs(cross);
    weightedX += (point.x + next.x) * cross;
    weightedZ += (point.z + next.z) * cross;
  }

  const degenerateThreshold = Number.EPSILON * Math.max(1, absoluteCrossSum);
  if (Math.abs(twiceArea) <= degenerateThreshold) return null;

  const center = {
    x: weightedX / (3 * twiceArea),
    z: weightedZ / (3 * twiceArea),
  };
  return Number.isFinite(center.x) && Number.isFinite(center.z)
    ? { center, winding: twiceArea > 0 ? 1 : -1 }
    : null;
}

function createWall(
  edge: FootprintEdge,
  edgeIndex: number,
  building: WorldBuilding,
  resolved: ReturnType<typeof resolveFacadeProfile>,
  layout: FacadeLayout,
  baseY: number,
): SvartaksiFacadeWall {
  const dx = edge.end.x - edge.start.x;
  const dz = edge.end.z - edge.start.z;
  const edgeCenter = { x: (edge.start.x + edge.end.x) / 2, z: (edge.start.z + edge.end.z) / 2 };
  const outward = outwardNormal(dx / edge.width, dz / edge.width);
  return {
    centerX: edgeCenter.x,
    centerY: baseY + building.height / 2,
    centerZ: edgeCenter.z,
    width: edge.width,
    height: building.height,
    yaw: Math.atan2(dz, dx),
    outwardX: outward.x,
    outwardZ: outward.z,
    profileKey: resolved.profileKey,
    family: resolved.family,
    variant: resolved.variant,
    profile: resolved.profile,
    layout,
    seed: stableSeed(`${building.id}:${edgeIndex}`),
  };
}

/**
 * Reorders a footprint so its edges are always traversed in the same rotational
 * direction (negative signed area in this x/z frame), keeping the first vertex fixed
 * so the result stays deterministic for a given ring.
 *
 * Source polygons arrive in both windings, and the renderer builds each wall's instance
 * matrix as (edge direction, up, outward normal). For one winding that basis is
 * right-handed and for the other it is mirrored — a negative determinant, which flips
 * the drawn triangle winding. An InstancedMesh cannot compensate for that per instance
 * (Three only checks the mesh's own world matrix), so with mixed windings roughly half
 * the city's walls, doorsteps and awnings face inward. That was survivable only while
 * facades rendered DoubleSide, which paid for both faces of every wall and painted the
 * window grid on the inside as well. Canonicalizing the winding here is what lets those
 * materials cull to their outward face alone.
 */
function orientFootprint(points: LocalPoint[], winding: 1 | -1): LocalPoint[] {
  return winding > 0 ? [points[0], ...points.slice(1).reverse()] : points;
}

/** Outward normal of an edge of a canonically-wound footprint (see orientFootprint) —
 * the edge direction turned a quarter turn away from the polygon's interior. */
function outwardNormal(directionX: number, directionZ: number): LocalPoint {
  return { x: cleanZero(-directionZ), z: cleanZero(directionX) };
}

function toDoorCandidate(wall: SvartaksiFacadeWall): DoorWallCandidate {
  const halfWidth = wall.width / 2;
  const directionX = Math.cos(wall.yaw);
  const directionZ = Math.sin(wall.yaw);
  return {
    startX: wall.centerX - directionX * halfWidth,
    startY: wall.centerZ - directionZ * halfWidth,
    endX: wall.centerX + directionX * halfWidth,
    endY: wall.centerZ + directionZ * halfWidth,
    width: wall.width,
    height: wall.height,
    minHeight: 0,
    sidePadding: wall.profile.sidePadding,
  };
}

function stableSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

function cleanZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
