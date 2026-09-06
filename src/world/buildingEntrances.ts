import type { LocalPoint, WorldData } from './types';

function pointSegmentDistance(point: LocalPoint, start: LocalPoint, end: LocalPoint): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq));
  return Math.hypot(point.x - (start.x + dx * t), point.z - (start.z + dz * t));
}

function distanceToBuilding(point: LocalPoint, ring: LocalPoint[]): number {
  let nearest = Infinity;
  for (let index = 0; index < ring.length; index += 1) {
    nearest = Math.min(nearest, pointSegmentDistance(point, ring[index], ring[(index + 1) % ring.length]));
  }
  return nearest;
}

export function attachEntrancesToBuildings(data: WorldData): WorldData {
  const byBuilding = new Map<number, WorldData['buildings'][number]['entrances']>();
  for (const entrance of data.objects.filter((object) => object.kind === 'entrance')) {
    let nearestIndex = -1;
    let nearestDistance = 3;
    data.buildings.forEach((building, index) => {
      const ring = building.rings[0];
      if (!ring) return;
      const distance = distanceToBuilding(entrance.point, ring);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex >= 0) {
      const entries = byBuilding.get(nearestIndex) ?? [];
      entries.push({ point: entrance.point, tags: entrance.properties });
      byBuilding.set(nearestIndex, entries);
    }
  }
  if (!byBuilding.size) return data;
  return {
    ...data,
    buildings: data.buildings.map((building, index) => {
      const entrances = byBuilding.get(index);
      return entrances ? { ...building, entrances: [...(building.entrances ?? []), ...entrances] } : building;
    }),
  };
}
