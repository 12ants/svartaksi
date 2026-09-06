/** Named facade color palettes plus keyword-based area classification (historic/commercial/etc.) used to pick one. */
import * as THREE from 'three';

export type FacadeColorScheme =
  | 'stockholm-dusk' | 'nordic-day' | 'night-noir' | 'high-contrast';
export type FacadeAreaKind =
  | 'historic' | 'residential' | 'commercial' | 'industrial' | 'mixed' | 'unknown';
export type FacadeVariant = 0 | 1 | 2;
export type FacadeFamily = 'residential' | 'office' | 'commercial' | 'industrial' | 'store';

export interface FacadePalette {
  residential: string;
  commercial: string;
  office: string;
  industrial: string;
  store: string;
  litWindow: string;
  doorAccent: string;
  pavement: string;
}

export const FACADE_PALETTES: Record<FacadeColorScheme, FacadePalette> = {
  'stockholm-dusk': { residential: '#6F655D', commercial: '#755C55', office: '#566473', industrial: '#665B50', store: '#8B4A3D', litWindow: '#FFD98A', doorAccent: '#9A603F', pavement: '#77736C' },
  'nordic-day': { residential: '#D8D3C8', commercial: '#C9B8A5', office: '#A9BBC8', industrial: '#B6B1A7', store: '#D9855F', litWindow: '#FFF2C2', doorAccent: '#76523C', pavement: '#C8C5BD' },
  'night-noir': { residential: '#2B2E33', commercial: '#342F32', office: '#202A35', industrial: '#35312D', store: '#4A2A28', litWindow: '#D7E8FF', doorAccent: '#7A5848', pavement: '#414349' },
  'high-contrast': { residential: '#737373', commercial: '#806A54', office: '#3F607A', industrial: '#6B624D', store: '#B5502E', litWindow: '#FFF59D', doorAccent: '#E69F00', pavement: '#B5B5B5' },
};

const AREA_KEYWORDS: Array<[FacadeAreaKind, readonly string[]]> = [
  ['historic', ['gamla stan', 'old town', 'historic']],
  ['industrial', ['industrial', 'warehouse', 'hamn']],
  ['commercial', ['commercial', 'shopping', 'retail']],
  ['residential', ['residential', 'housing', 'apartments']],
  ['mixed', ['mixed', 'civic', 'park']],
];

export function classifyFacadeArea(areaName: string, featureDetails: readonly string[]): FacadeAreaKind {
  const haystack = `${areaName} ${featureDetails.join(' ')}`.trim().toLowerCase();
  return AREA_KEYWORDS.find(([, words]) => words.some(word => haystack.includes(word)))?.[0] ?? 'unknown';
}

export function stableFacadeVariant(identity: string, areaId: string, scheme: FacadeColorScheme): FacadeVariant {
  let hash = 2166136261;
  for (const char of `${identity}|${areaId}|${scheme}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash >>> 0) % 3) as FacadeVariant;
}

function shifted(hex: string, hue: number, saturation: number, lightness: number): string {
  const color = new THREE.Color(hex);
  color.offsetHSL(hue, saturation, lightness);
  return `#${color.getHexString().toUpperCase()}`;
}

export function resolveFacadeColors(
  scheme: FacadeColorScheme,
  family: FacadeFamily,
  variant: FacadeVariant,
  areaKind: FacadeAreaKind,
) {
  const palette = FACADE_PALETTES[scheme];
  const lightness = ([-0.04, 0, 0.04] as const)[variant];
  const areaHue = scheme === 'high-contrast' ? 0 : areaKind === 'historic' ? 0.015 : areaKind === 'industrial' ? -0.01 : 0;
  const areaSaturation = scheme === 'high-contrast' ? 0 : areaKind === 'historic' ? 0.025 : areaKind === 'industrial' ? -0.03 : 0;
  return {
    wallColor: shifted(palette[family], areaHue, areaSaturation, lightness),
    windowColor: palette.litWindow,
    doorColor: palette.doorAccent,
  };
}
