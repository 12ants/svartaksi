/** Maps mapped door/entrance points onto a building's facade walls, with a deterministic fallback when no mapped door fits. */
import type { DoorStyle } from './doorStyle';

export interface DoorPoint {
  id: string;
  x: number;
  y: number;
  parentId?: string;
}

export interface DoorWallCandidate {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  height: number;
  minHeight: number;
  sidePadding: number;
}

export interface DoorProjection {
  t: number;
  localX: number;
  distance: number;
}

export interface DoorPlacement {
  wallIndex: number;
  centerX: number;
  bottom: number;
  width: number;
  height: number;
  source: 'mapped' | 'fallback';
  entranceId?: string;
}

export type DoorOutcome = 'mapped' | 'fallback' | 'omitted' | 'invalid';

export interface DoorSelection {
  doors: DoorPlacement[];
  outcome: DoorOutcome;
}

/** A glazed pane set into a door, sized and positioned relative to the door's own
 * rectangle (`bottom` is height above the door's own bottom, not the ground). */
export interface DoorGlassPane {
  width: number;
  height: number;
  bottom: number;
}

/** A resolved door as attached to one facade wall. */
export type FacadeDoorRecord = Omit<DoorPlacement, 'wallIndex'> & {
  glass?: DoorGlassPane;
  style: DoorStyle;
};

export interface ParentDoorPlacement extends DoorPlacement {
  partId: string;
}

export interface ParentDoorSelection {
  doors: ParentDoorPlacement[];
  outcome: DoorOutcome;
}

export interface DoorParentCandidate {
  parentId: string;
  parts: Array<{ partId: string; walls: DoorWallCandidate[] }>;
}

export const DEFAULT_DOOR_WIDTH = 1.1;
export const DEFAULT_DOOR_HEIGHT = 2.2;
export const DEFAULT_DOOR_BOTTOM = 0.02;
const MAX_MAPPED_DISTANCE = 2;
const MAX_GROUND_MIN_HEIGHT = 0.25;

/** Project a point onto a wall without accepting extensions beyond either endpoint. */
export function projectPointToWall(
  point: { x: number; y: number },
  wall: DoorWallCandidate,
  maxDistance = MAX_MAPPED_DISTANCE,
): DoorProjection | null {
  const dx = wall.endX - wall.startX;
  const dy = wall.endY - wall.startY;
  const lengthSq = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSq) || lengthSq <= 0) return null;
  const t = ((point.x - wall.startX) * dx + (point.y - wall.startY) * dy) / lengthSq;
  if (t < 0 || t > 1) return null;
  const projectedX = wall.startX + dx * t;
  const projectedY = wall.startY + dy * t;
  const distance = Math.hypot(point.x - projectedX, point.y - projectedY);
  if (!Number.isFinite(distance) || distance > maxDistance) return null;
  return { t, localX: t * wall.width, distance };
}

/** Clamp a door center into the complete opening range, or reject a narrow wall. */
export function snapDoorCenter(
  centerX: number,
  wallWidth: number,
  sidePadding: number,
  doorWidth = DEFAULT_DOOR_WIDTH,
): number | null {
  const minimum = sidePadding + doorWidth / 2;
  const maximum = wallWidth - sidePadding - doorWidth / 2;
  if (![centerX, wallWidth, sidePadding, doorWidth].every(Number.isFinite)) return null;
  if (doorWidth <= 0 || minimum > maximum) return null;
  return Math.min(maximum, Math.max(minimum, centerX));
}

function isEligible(wall: DoorWallCandidate): boolean {
  return (
    wall.minHeight <= MAX_GROUND_MIN_HEIGHT &&
    wall.height >= DEFAULT_DOOR_HEIGHT + DEFAULT_DOOR_BOTTOM &&
    snapDoorCenter(wall.width / 2, wall.width, wall.sidePadding) !== null
  );
}

/** Select stable mapped doors, or one centered fallback on the longest eligible wall. */
export function selectBuildingDoors(input: {
  walls: DoorWallCandidate[];
  entrances: DoorPoint[];
  detail: 'balanced' | 'rich';
  parentId?: string;
}): DoorSelection {
  const eligibleWalls = input.walls
    .map((candidate, wallIndex) => ({ candidate, wallIndex }))
    .filter(({ candidate }) => isEligible(candidate));

  const mapped = input.entrances
    .filter(entrance => !entrance.parentId || !input.parentId || entrance.parentId === input.parentId)
    .flatMap(entrance => {
      let best: { wallIndex: number; projection: DoorProjection } | null = null;
      for (const { candidate, wallIndex } of eligibleWalls) {
        const projection = projectPointToWall(entrance, candidate);
        if (!projection) continue;
        if (
          !best ||
          projection.distance < best.projection.distance ||
          (projection.distance === best.projection.distance && wallIndex < best.wallIndex)
        ) {
          best = { wallIndex, projection };
        }
      }
      if (!best) return [];
      const wall = input.walls[best.wallIndex];
      const centerX = snapDoorCenter(
        best.projection.localX,
        wall.width,
        wall.sidePadding,
      );
      if (centerX === null) return [];
      return [{
        wallIndex: best.wallIndex,
        centerX,
        bottom: DEFAULT_DOOR_BOTTOM,
        width: DEFAULT_DOOR_WIDTH,
        height: DEFAULT_DOOR_HEIGHT,
        source: 'mapped' as const,
        entranceId: entrance.id,
        distance: best.projection.distance,
      }];
    })
    .sort((a, b) => {
      const distanceDelta = a.distance - b.distance;
      if (Math.abs(distanceDelta) > 1e-9) return distanceDelta;
      return a.wallIndex - b.wallIndex ||
        (a.entranceId ?? '').localeCompare(b.entranceId ?? '');
    });

  if (mapped.length > 0) {
    const seenWalls = new Set<number>();
    const limit = input.detail === 'rich' ? Number.POSITIVE_INFINITY : 1;
    const doors: DoorPlacement[] = [];
    for (const candidate of mapped) {
      if (seenWalls.has(candidate.wallIndex)) continue;
      seenWalls.add(candidate.wallIndex);
      doors.push({
        wallIndex: candidate.wallIndex,
        centerX: candidate.centerX,
        bottom: candidate.bottom,
        width: candidate.width,
        height: candidate.height,
        source: candidate.source,
        entranceId: candidate.entranceId,
      });
      if (doors.length >= limit) break;
    }
    return { doors, outcome: 'mapped' };
  }

  const fallback = [...eligibleWalls].sort(
    (a, b) => b.candidate.width - a.candidate.width || a.wallIndex - b.wallIndex,
  )[0];
  if (fallback) {
    return {
      doors: [{
        wallIndex: fallback.wallIndex,
        centerX: fallback.candidate.width / 2,
        bottom: DEFAULT_DOOR_BOTTOM,
        width: DEFAULT_DOOR_WIDTH,
        height: DEFAULT_DOOR_HEIGHT,
        source: 'fallback',
      }],
      outcome: 'fallback',
    };
  }

  return {
    doors: [],
    outcome: input.entrances.length > 0 ? 'invalid' : 'omitted',
  };
}

/** Flatten all parts for one parent so feature order cannot choose the winning wall. */
export function selectParentDoors(input: {
  parts: Array<{ partId: string; walls: DoorWallCandidate[] }>;
  entrances: DoorPoint[];
  detail: 'balanced' | 'rich';
  parentId?: string;
}): ParentDoorSelection {
  const wallOwners: Array<{ partId: string; wallIndex: number }> = [];
  const walls: DoorWallCandidate[] = [];
  for (const part of input.parts) {
    part.walls.forEach((candidate, wallIndex) => {
      walls.push(candidate);
      wallOwners.push({ partId: part.partId, wallIndex });
    });
  }
  const selection = selectBuildingDoors({
    walls,
    entrances: input.entrances,
    detail: input.detail,
    parentId: input.parentId,
  });
  return {
    outcome: selection.outcome,
    doors: selection.doors.map(door => ({
      ...door,
      partId: wallOwners[door.wallIndex].partId,
      wallIndex: wallOwners[door.wallIndex].wallIndex,
    })),
  };
}

/** Assign each rendered entrance to one parent before per-parent door selection. */
export function assignEntrancesToParents(
  parents: DoorParentCandidate[],
  entrances: DoorPoint[],
): Map<string, DoorPoint[]> {
  const assignments = new Map<string, DoorPoint[]>();
  const parentIds = new Set(parents.map(parent => parent.parentId));
  const assign = (parentId: string, entrance: DoorPoint) => {
    const points = assignments.get(parentId) ?? [];
    points.push(entrance);
    assignments.set(parentId, points);
  };

  for (const entrance of entrances) {
    if (entrance.parentId) {
      if (parentIds.has(entrance.parentId)) assign(entrance.parentId, entrance);
      continue;
    }
    let best: { parentId: string; distance: number } | null = null;
    for (const parent of parents) {
      for (const part of parent.parts) {
        for (const wall of part.walls) {
          if (!isEligible(wall)) continue;
          const projection = projectPointToWall(entrance, wall);
          if (!projection) continue;
          if (
            !best ||
            projection.distance < best.distance - 1e-9 ||
            (Math.abs(projection.distance - best.distance) <= 1e-9 &&
              parent.parentId.localeCompare(best.parentId) < 0)
          ) {
            best = { parentId: parent.parentId, distance: projection.distance };
          }
        }
      }
    }
    if (best) assign(best.parentId, entrance);
  }
  return assignments;
}

/** Three fixed size tiers a glazed door pane can land on — a small transom near the
 * top, a centered mid-size pane, or a nearly full-height glazed door — expressed as
 * ratios of the door's own width/height so they scale with whatever door they land
 * on instead of being fixed absolute sizes. */
const DOOR_GLASS_TIERS: ReadonlyArray<{ widthRatio: number; heightRatio: number; bottomRatio: number }> = [
  { widthRatio: 0.34, heightRatio: 0.28, bottomRatio: 0.62 },
  { widthRatio: 0.52, heightRatio: 0.5, bottomRatio: 0.38 },
  { widthRatio: 0.74, heightRatio: 0.8, bottomRatio: 0.12 },
];

/** Fraction of doors that get a glass pane at all — the rest stay solid. */
const DOOR_GLASS_CHANCE = 0.45;

/** Deterministic glass pane for a door, or undefined for a plain solid door. Reuses a
 * single stable `seed` (0..1, e.g. the wall's own seed) for both the presence roll and
 * the size-tier pick — deterministic and stable across rebuilds without a second hash. */
export function glassPaneForDoor(
  seed: number,
  door: { width: number; height: number },
): DoorGlassPane | undefined {
  if (!Number.isFinite(seed) || seed >= DOOR_GLASS_CHANCE) return undefined;
  const tierRoll = seed / DOOR_GLASS_CHANCE;
  const tier = DOOR_GLASS_TIERS[Math.min(DOOR_GLASS_TIERS.length - 1, Math.floor(tierRoll * DOOR_GLASS_TIERS.length))];
  return {
    width: door.width * tier.widthRatio,
    height: door.height * tier.heightRatio,
    bottom: door.height * tier.bottomRatio,
  };
}
