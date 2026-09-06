import type { LocalPoint, WorldBuilding, WorldData, WorldObject, WorldRoad } from '../types';
import type { ProceduralArea, ProceduralCategory, ProceduralRule, ProceduralWorldProject } from './types';

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0) / 0x1_0000_0000;
}

function inside(point: LocalPoint, area: ProceduralArea): boolean {
  let hit = false;
  for (let i = 0, j = area.points.length - 1; i < area.points.length; j = i, i += 1) {
    const a = area.points[i];
    const b = area.points[j];
    if (((a.z > point.z) !== (b.z > point.z))
      && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function pointFor(category: ProceduralCategory, feature: WorldBuilding | WorldRoad | WorldObject | { rings: LocalPoint[][] }): LocalPoint {
  if (category === 'roads') return (feature as WorldRoad).points[0] ?? { x: 0, z: 0 };
  if (category === 'objects' || category === 'trees') return (feature as WorldObject).point;
  return (feature as WorldBuilding).rings[0]?.[0] ?? { x: 0, z: 0 };
}

function matches(
  rule: ProceduralRule,
  category: ProceduralCategory,
  feature: WorldBuilding | WorldRoad | WorldObject | { id: string; kind: string; rings: LocalPoint[][] },
  areas: ProceduralArea[],
): boolean {
  if (!rule.enabled || (rule.match.category !== 'all' && rule.match.category !== category)) return false;
  if (rule.match.featureId && rule.match.featureId !== feature.id) return false;
  if (rule.match.kind && rule.match.kind !== ('kind' in feature ? feature.kind : undefined)) return false;
  if (rule.match.property) {
    const properties = 'properties' in feature ? feature.properties : {};
    if (String(properties[rule.match.property.key] ?? '') !== rule.match.property.value) return false;
  }
  if (rule.match.areaId) {
    const area = areas.find((candidate) => candidate.id === rule.match.areaId);
    if (!area || !inside(pointFor(category, feature), area)) return false;
  }
  return true;
}

function effectsFor(
  project: ProceduralWorldProject,
  category: ProceduralCategory,
  feature: Parameters<typeof matches>[2],
) {
  return project.rules.filter((rule) => matches(rule, category, feature, project.areas))
    .map((rule) => rule.effects)
    .reduce((combined, effects) => ({ ...combined, ...effects }), {});
}

function include(project: ProceduralWorldProject, id: string, probability = 1): boolean {
  return hash(`${project.seed}:${id}`) < Math.max(0, Math.min(1, probability));
}

export function resolveProceduralWorld(source: WorldData, project: ProceduralWorldProject): WorldData {
  const buildings = source.buildings.flatMap((building) => {
    const effects = effectsFor(project, 'buildings', building);
    if (effects.visible === false || !include(project, building.id, effects.probability)) return [];
    const variation = effects.variation ?? 0;
    const factor = 1 + (hash(`${project.seed}:${building.id}:height`) * 2 - 1) * variation;
    return [{
      ...building,
      height: building.height * (effects.heightScale ?? 1) * factor,
      appearance: {
        ...building.appearance,
        ...(effects.wallColor ? { wallColor: effects.wallColor } : {}),
        ...(effects.roofColor ? { roofColor: effects.roofColor } : {}),
      },
    }];
  });
  const roads = source.roads.flatMap((road) => {
    const effects = effectsFor(project, 'roads', road);
    if (effects.visible === false || !include(project, road.id, effects.probability)) return [];
    return [{ ...road, width: road.width * (effects.widthScale ?? 1) }];
  });
  const areas = (category: 'parks' | 'water', values: WorldData[typeof category]) => values.filter((area) => {
    const effects = effectsFor(project, category, area);
    return effects.visible !== false && include(project, area.id, effects.probability);
  });
  const objects = source.objects.filter((object) => {
    const category = object.kind === 'tree' ? 'trees' : 'objects';
    const effects = effectsFor(project, category, object);
    return effects.visible !== false && include(project, object.id, (effects.probability ?? 1) * (effects.density ?? 1));
  });
  return {
    ...source,
    buildings: [...buildings, ...project.overlay.buildings],
    roads: [...roads, ...project.overlay.roads],
    parks: [...areas('parks', source.parks), ...project.overlay.parks],
    water: [...areas('water', source.water), ...project.overlay.water],
    labels: [...source.labels, ...project.overlay.labels],
    objects: [...objects, ...project.overlay.objects],
  };
}
