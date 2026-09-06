import type { WorldBuildingAppearance } from './types';

const CSS_COLORS = new Set([
  'black', 'blue', 'brown', 'gray', 'green', 'grey', 'orange', 'red', 'white', 'yellow',
  'beige', 'brick', 'cream', 'silver',
]);

function stringTag(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim().toLowerCase();
  return normalized || undefined;
}

function colorTag(value: unknown): string | undefined {
  const normalized = stringTag(value);
  if (!normalized) return undefined;
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(normalized) || CSS_COLORS.has(normalized)) return normalized;
  return undefined;
}

function numberTag(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeBuildingAppearance(properties: Record<string, unknown>): WorldBuildingAppearance {
  const values: WorldBuildingAppearance = {
    buildingKind: stringTag(properties.building ?? properties.type ?? properties.class),
    buildingUse: stringTag(properties['building:use'] ?? properties.office ?? properties.shop ?? properties.amenity ?? properties.tourism),
    material: stringTag(properties['building:material'] ?? properties.material),
    wallColor: colorTag(properties['building:colour'] ?? properties['building:color']),
    roofShape: stringTag(properties['roof:shape']),
    roofMaterial: stringTag(properties['roof:material']),
    roofColor: colorTag(properties['roof:colour'] ?? properties['roof:color']),
    levels: numberTag(properties['building:levels']),
    houseNumber: stringTag(properties['addr:housenumber']),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
