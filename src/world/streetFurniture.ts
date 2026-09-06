import { pointInRing } from './geo';
import { isPavementClear } from './roadClearance';
import { boundsOfPoints } from './spatialGrid';
import type { LocalPoint, WorldArea, WorldData, WorldObject } from './types';

export const MAX_GENERATED_FURNITURE = 180;
const STREET_KINDS = new Set(['residential', 'living_street', 'tertiary', 'unclassified', 'pedestrian']);
const PARK_KINDS = new Set(['park', 'garden', 'recreation_ground']);

function inside(point: LocalPoint, area: WorldArea): boolean {
  return Boolean(area.rings[0] && pointInRing(point, area.rings[0])
    && !area.rings.slice(1).some((ring) => pointInRing(point, ring)));
}

/** Yield per candidate so a dense snapshot cannot hold the world builder's frame. */
export function* generateStreetFurniture(
  data: WorldData,
  anchor: LocalPoint,
  radius: number,
  avoid: readonly LocalPoint[] = [],
): Generator<void, WorldObject[]> {
  const result: WorldObject[] = [];
  const occupied = [...data.objects.map((object) => object.point), ...avoid];
  const place = (id: string, kind: string, point: LocalPoint, footprint: number, park?: WorldArea) => {
    if (Math.hypot(point.x - anchor.x, point.z - anchor.z) > radius) return;
    if (occupied.some((other) => Math.hypot(point.x - other.x, point.z - other.z) < 6)) return;
    // Test the whole footprint, including corners, to keep props off shores and walls.
    for (const dx of [-footprint, 0, footprint]) {
      for (const dz of [-footprint, 0, footprint]) {
        const probe = { x: point.x + dx, z: point.z + dz };
        if (!isPavementClear(probe.x, probe.z, data.roads, 0.3, data.buildings)) return;
        if (data.water.some((area) => inside(probe, area))) return;
        if (park && !inside(probe, park)) return;
      }
    }
    result.push({ id, kind, point, properties: { generated: true } });
    occupied.push(point);
  };
  // Reserve space for park landmarks before the more numerous roadside objects.
  for (const park of data.parks) {
    yield;
    if (!PARK_KINDS.has(park.kind)) continue;
    const bounds = boundsOfPoints(park.rings[0] ?? []);
    if (!bounds || bounds.maxX - bounds.minX < 18 || bounds.maxZ - bounds.minZ < 18) continue;
    place(`furniture:${park.id}:fountain`, 'fountain', {
      x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2,
    }, 1.4, park);
    if (result.length >= MAX_GENERATED_FURNITURE) return result;
  }
  for (const road of data.roads) {
    yield;
    if (!STREET_KINDS.has(road.kind) || (road.structure && road.structure !== 'ground')) continue;
    let along = 0;
    let next = 35;
    let slot = 0;
    for (let index = 1; index < road.points.length; index += 1) {
      const a = road.points[index - 1];
      const b = road.points[index];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.001) continue;
      while (next <= along + length) {
        yield;
        const t = (next - along) / length;
        const offset = road.width / 2 + 2.5;
        const side = slot % 2 === 0 ? 1 : -1;
        const point = {
          x: a.x + (b.x - a.x) * t - (b.z - a.z) / length * offset * side,
          z: a.z + (b.z - a.z) * t + (b.x - a.x) / length * offset * side,
        };
        const kind = slot % 3 === 2 ? 'bench' : 'waste_basket';
        place(`furniture:${road.id}:${slot}`, kind, point, kind === 'bench' ? 1 : 0.3);
        if (result.length >= MAX_GENERATED_FURNITURE) return result;
        slot += 1;
        next += 90;
      }
      along += length;
    }
  }
  return result;
}
