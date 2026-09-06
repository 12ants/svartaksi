import { localToLngLat, pointInRing, ringCentroid } from '../world/geo';
// Re-exported: doorstep.ts and the spawn tests reach for it here.
export { pointInRing } from '../world/geo';
import type { LngLat, LocalPoint, WorldArea, WorldBuilding, WorldData } from '../world/types';
import { START_LOCATION } from './config';

export interface SafeSpawn {
  local: LocalPoint;
  lngLat: LngLat;
  sourceAreaId: string;
  sourceAreaKind: string;
}

const OPEN_FIELD_KINDS = new Set([
  'park', 'garden', 'grass', 'meadow', 'recreation_ground', 'allotments', 'pitch',
]);


function insideAny(point: LocalPoint, areas: Array<WorldArea | WorldBuilding>): boolean {
  return areas.some((area) => {
    const outer = area.rings[0];
    return Boolean(outer && pointInRing(point, outer));
  });
}

export function isSafeSpawnPoint(point: LocalPoint, data: WorldData): boolean {
  return !insideAny(point, data.water) && !insideAny(point, data.buildings);
}

function boundsOf(ring: LocalPoint[]) {
  return ring.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minZ: Math.min(bounds.minZ, point.z),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

export function chooseRandomSpawn(data: WorldData, random: () => number = Math.random): SafeSpawn | null {
  const candidates = data.parks
    .filter((area) => OPEN_FIELD_KINDS.has(area.kind) && (area.rings[0]?.length ?? 0) >= 3)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!candidates.length) return null;

  const start = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const area = candidates[(start + offset) % candidates.length];
    const ring = area.rings[0];
    const centroid = ringCentroid(ring);
    const points = [centroid];
    const bounds = boundsOf(ring);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      points.push({
        x: bounds.minX + (bounds.maxX - bounds.minX) * random(),
        z: bounds.minZ + (bounds.maxZ - bounds.minZ) * random(),
      });
    }
    const local = points.find((point) => pointInRing(point, ring) && isSafeSpawnPoint(point, data));
    if (local) {
      return {
        local,
        lngLat: localToLngLat(START_LOCATION, local),
        sourceAreaId: area.id,
        sourceAreaKind: area.kind,
      };
    }
  }
  return null;
}
