import type { ProceduralPreset } from './types';

export const PROCEDURAL_PRESETS: readonly ProceduralPreset[] = [
  { version: 1, id: 'balanced', name: 'Balanced city', rules: [], renderOptions: { quality: 'balanced' } },
  { version: 1, id: 'sparse', name: 'Low-end sparse', rules: [{ id: 'sparse-trees', name: 'Sparse trees', enabled: true, match: { category: 'trees' }, effects: { density: 0.35 } }], renderOptions: { quality: 'performance', highQualityShadows: false } },
  { version: 1, id: 'dense', name: 'Dense cinematic', rules: [{ id: 'dense-trees', name: 'Dense trees', enabled: true, match: { category: 'trees' }, effects: { density: 1 } }, { id: 'varied-buildings', name: 'Building variation', enabled: true, match: { category: 'buildings' }, effects: { variation: 0.12 } }], renderOptions: { quality: 'high' } },
  { version: 1, id: 'mono', name: 'Restrained monochrome', rules: [{ id: 'mono-buildings', name: 'Gray facades', enabled: true, match: { category: 'buildings' }, effects: { wallColor: '#8b8b86', roofColor: '#353535' } }], renderOptions: {} },
  { version: 1, id: 'facades', name: 'Facade study', rules: [{ id: 'facade-study', name: 'Facade variation', enabled: true, match: { category: 'buildings' }, effects: { variation: 0.2 } }], renderOptions: { facades: true, facadeDetails: true } },
  { version: 1, id: 'vegetation', name: 'Vegetation study', rules: [{ id: 'vegetation-study', name: 'Vegetation only', enabled: true, match: { category: 'buildings' }, effects: { visible: false } }], renderOptions: { streetFurniture: false } },
  { version: 1, id: 'night', name: 'Night lighting study', rules: [], renderOptions: { streetLights: true, highQualityShadows: true } },
];
