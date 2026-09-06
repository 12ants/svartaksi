import { describe, expect, it } from 'vitest';
import { createDefaultProceduralProject } from '@/world/procedural/defaultProject';
import { PROCEDURAL_SAMPLE_WORLD } from '@/world/procedural/sampleWorld';
import { resolveProceduralWorld } from '@/world/procedural/resolveProceduralWorld';

describe('procedural world resolution', () => {
  it('is deterministic and applies category effects', () => {
    const project = createDefaultProceduralProject();
    project.rules = [{ id: 'buildings', name: 'Buildings', enabled: true, match: { category: 'buildings' }, effects: { heightScale: 2, variation: 0.1, wallColor: '#111111' } }];
    const first = resolveProceduralWorld(PROCEDURAL_SAMPLE_WORLD, project);
    const second = resolveProceduralWorld(PROCEDURAL_SAMPLE_WORLD, project);
    expect(first).toEqual(second);
    expect(first.buildings[0].height).not.toBe(PROCEDURAL_SAMPLE_WORLD.buildings[0].height);
    expect(first.buildings[0].appearance?.wallColor).toBe('#111111');
  });

  it('lets later feature rules override global category rules', () => {
    const project = createDefaultProceduralProject();
    project.rules = [
      { id: 'hide', name: 'Hide', enabled: true, match: { category: 'buildings' }, effects: { visible: false } },
      { id: 'show-house', name: 'Show house', enabled: true, match: { category: 'buildings', featureId: 'house' }, effects: { visible: true } },
    ];
    expect(resolveProceduralWorld(PROCEDURAL_SAMPLE_WORLD, project).buildings.map(({ id }) => id)).toEqual(['house']);
  });

  it('scales roads and filters trees by stable density', () => {
    const project = createDefaultProceduralProject();
    project.rules = [
      { id: 'roads', name: 'Roads', enabled: true, match: { category: 'roads' }, effects: { widthScale: 1.5 } },
      { id: 'trees', name: 'Trees', enabled: true, match: { category: 'trees' }, effects: { density: 0 } },
    ];
    const result = resolveProceduralWorld(PROCEDURAL_SAMPLE_WORLD, project);
    expect(result.roads[0].width).toBe(13.5);
    expect(result.objects.some(({ kind }) => kind === 'tree')).toBe(false);
  });
});
