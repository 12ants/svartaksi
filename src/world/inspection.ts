import type { WorldSource } from './types';

export const INSPECTION_USER_DATA_KEY = 'svartaksiInspection';

export interface WorldInspectionRecord {
  id: string;
  category: 'building' | 'roof' | 'road' | 'area' | 'water' | 'object' | 'vehicle' | 'player';
  title: string;
  source: WorldSource | 'runtime';
  properties: Record<string, string | number | boolean>;
}

export function sanitizeInspectionProperties(
  input: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const entries = Object.entries(input)
    .filter((entry): entry is [string, string | number | boolean] => {
      const type = typeof entry[1];
      return type === 'string' || type === 'number' || type === 'boolean';
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 16)
    .map(([key, value]) => [
      key.slice(0, 48),
      typeof value === 'string' ? value.slice(0, 160) : value,
    ] as const);
  return Object.fromEntries(entries);
}
