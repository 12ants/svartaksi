import { DEFAULT_RENDER_OPTIONS } from '../renderOptions';
import type { WorldData } from '../types';
import type { ProceduralWorldProject } from './types';

const emptyOverlay = (): WorldData => ({
  source: 'maplibre', roads: [], buildings: [], water: [], parks: [], labels: [], objects: [],
});

export function createDefaultProceduralProject(): ProceduralWorldProject {
  return {
    version: 1,
    id: 'svartaksi-world',
    name: 'Svartaksi procedural world',
    seed: 1909,
    source: { kind: 'sample' },
    renderOptions: { ...DEFAULT_RENDER_OPTIONS },
    rules: [],
    areas: [],
    overlay: emptyOverlay(),
  };
}
