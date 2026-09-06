import type { LngLat, WorldData } from '../types';
import type { RenderOptions } from '../renderOptions';

export type ProceduralCategory = 'buildings' | 'roads' | 'parks' | 'water' | 'trees' | 'objects';

export interface ProceduralRuleMatch {
  category: ProceduralCategory | 'all';
  kind?: string;
  property?: { key: string; value: string };
  areaId?: string;
  featureId?: string;
}

export interface ProceduralRuleEffects {
  visible?: boolean;
  probability?: number;
  variation?: number;
  heightScale?: number;
  widthScale?: number;
  density?: number;
  wallColor?: string;
  roofColor?: string;
}

export interface ProceduralRule {
  id: string;
  name: string;
  enabled: boolean;
  match: ProceduralRuleMatch;
  effects: ProceduralRuleEffects;
}

export interface ProceduralArea {
  id: string;
  name: string;
  points: Array<{ x: number; z: number }>;
}

export interface ProceduralWorldSource {
  kind: 'sample' | 'live';
  center?: LngLat;
  radius?: number;
}

export interface ProceduralWorldProject {
  version: 1;
  id: string;
  name: string;
  seed: number;
  source: ProceduralWorldSource;
  renderOptions: RenderOptions;
  rules: ProceduralRule[];
  areas: ProceduralArea[];
  overlay: WorldData;
}

export interface ProceduralPreset {
  version: 1;
  id: string;
  name: string;
  rules: ProceduralRule[];
  renderOptions: Partial<RenderOptions>;
}
