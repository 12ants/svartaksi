import type { FacadeFamily } from './buildingFacade';
import type { WorldBuilding } from '../world/types';

export type DoorStyleKind = 'solid' | 'glazed' | 'double' | 'shopfront' | 'service';

export interface DoorStyle {
  kind: DoorStyleKind;
  frameWidth: number;
  panelCount: 1 | 2 | 4;
  glassRatio: number;
  color: string;
}

const COLORS: Record<DoorStyleKind, readonly string[]> = {
  solid: ['#70452F', '#315447', '#4D5360'],
  glazed: ['#5A4638', '#344D58', '#55504A'],
  double: ['#493B32', '#384851', '#66513A'],
  shopfront: ['#2E2924', '#3D312A', '#273941'],
  service: ['#42464B', '#55514B', '#343B40'],
};

export function resolveDoorStyle(input: {
  building: WorldBuilding;
  family: FacadeFamily;
  entranceTags: Record<string, unknown>;
  seed: number;
}): DoorStyle {
  const kind = resolveKind(input);
  const variant = Math.min(COLORS[kind].length - 1, Math.floor(clampSeed(input.seed) * COLORS[kind].length));
  return {
    kind,
    frameWidth: 0.06 + variant * 0.03,
    panelCount: kind === 'double' ? 2 : kind === 'shopfront' ? 4 : 1,
    glassRatio: kind === 'solid' || kind === 'service' ? 0.12 : kind === 'glazed' ? 0.58 : 0.82,
    color: COLORS[kind][variant],
  };
}

function resolveKind(input: {
  building: WorldBuilding;
  family: FacadeFamily;
  entranceTags: Record<string, unknown>;
}): DoorStyleKind {
  const tags = Object.values(input.entranceTags).map(String).join(' ').toLowerCase();
  if (/\b(service|delivery|industrial)\b/.test(tags) || /\b(private|no)\b/.test(String(input.entranceTags.access ?? '').toLowerCase())) {
    return 'service';
  }
  if (/\bdouble\b/.test(tags)) return 'double';
  if (/\b(shop|store|retail)\b/.test(tags)) return 'shopfront';
  if (/\b(glass|glazed|main)\b/.test(tags)) return 'glazed';

  const use = [
    input.building.appearance?.buildingKind,
    input.building.appearance?.buildingUse,
    input.building.properties.building,
    input.building.properties['building:use'],
  ].filter(Boolean).join(' ').toLowerCase();
  if (input.family === 'industrial' || /industrial|warehouse|service/.test(use)) return 'service';
  if (input.family === 'store') return 'shopfront';
  if (input.family === 'commercial' || input.family === 'office') return 'double';
  return 'solid';
}

function clampSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.min(0.999_999, Math.max(0, seed)) : 0;
}
