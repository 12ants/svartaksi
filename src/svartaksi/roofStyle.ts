import type { WorldBuilding } from '../world/types';

export interface RoofStyle {
  color: string;
  roughness: number;
  capLift: number;
}

function stableNumber(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

export function resolveRoofStyle(building: WorldBuilding): RoofStyle {
  const variation = stableNumber(building.id);
  const appearance = building.appearance;
  const material = appearance?.roofMaterial ?? String(building.properties['roof:material'] ?? '').toLowerCase();
  const explicit = appearance?.roofColor;
  const color = explicit
    ?? (material === 'metal' ? '#56646b'
      : /tile|brick/.test(material) ? '#8b5142'
        : variation < 0.34 ? '#46525c' : variation < 0.67 ? '#79524a' : '#8b654d');
  return {
    color,
    roughness: material === 'metal' ? 0.62 : /tile|brick/.test(material) ? 0.88 : 0.82 + variation * 0.12,
    capLift: 0.035 + variation * 0.012,
  };
}
