import { describe, expect, it } from 'vitest';
import { isSurfaceVisible, surfaceVisibility } from '../../src/world/surfaceVisibility';
import type { WorldRoad } from '../../src/world/types';

const road = (patch: Partial<WorldRoad> = {}): WorldRoad => ({
  id: 'r1', kind: 'residential', width: 6, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], ...patch,
});

describe('surfaceVisibility', () => {
  it('shows an ordinary at-grade road (no structure, layer 0)', () => {
    expect(surfaceVisibility(road())).toBe('visible');
    expect(surfaceVisibility(road({ structure: 'ground', layer: 0 }))).toBe('visible');
  });

  it('hides tunnels by default', () => {
    expect(surfaceVisibility(road({ structure: 'tunnel' }))).toBe('hidden');
    expect(surfaceVisibility(road({ structure: 'tunnel', layer: -1 }))).toBe('hidden');
    // Even a tunnel tagged with a positive layer is still a tunnel — structure wins.
    expect(surfaceVisibility(road({ structure: 'tunnel', layer: 1 }))).toBe('hidden');
  });

  it('keeps bridges surface-visible, including at any layer', () => {
    expect(surfaceVisibility(road({ structure: 'bridge', layer: 1 }))).toBe('visible');
    expect(surfaceVisibility(road({ structure: 'bridge', layer: 0 }))).toBe('visible');
    // A bridge is above whatever it crosses by definition, regardless of layer sign.
    expect(surfaceVisibility(road({ structure: 'bridge', layer: -1 }))).toBe('visible');
  });

  it('draws underpass ground roads (negative layer, no bridge/tunnel tag)', () => {
    // A negative layer is ordering evidence, not a structure. The elevation profile lifts
    // the road *above* rather than digging this one (only an explicit tunnel is dug), so
    // the underpass is an ordinary at-grade ribbon with the deck clear above it.
    // Hiding it left a hole in the street grid under every bridge.
    expect(surfaceVisibility(road({ structure: 'ground', layer: -1 }))).toBe('visible');
    expect(surfaceVisibility(road({ layer: -2 }))).toBe('visible');
  });

  it('treats ford like ground for visibility purposes', () => {
    expect(surfaceVisibility(road({ structure: 'ford', layer: 0 }))).toBe('visible');
    expect(surfaceVisibility(road({ structure: 'ford', layer: -1 }))).toBe('visible');
  });

  it('defaults missing structure/layer fields to the visible ground case', () => {
    expect(surfaceVisibility({})).toBe('visible');
  });
});

describe('isSurfaceVisible (debug override)', () => {
  it('follows surfaceVisibility when no override is given', () => {
    expect(isSurfaceVisible(road({ structure: 'tunnel' }))).toBe(false);
    expect(isSurfaceVisible(road())).toBe(true);
  });

  it('reveals hidden roads only when the explicit debug override is set', () => {
    expect(isSurfaceVisible(road({ structure: 'tunnel' }), { debugShowHiddenRoads: true })).toBe(true);
    expect(isSurfaceVisible(road({ structure: 'tunnel' }), { debugShowHiddenRoads: false })).toBe(false);
  });

  it('does not hide an otherwise-visible road just because the override is off', () => {
    expect(isSurfaceVisible(road(), { debugShowHiddenRoads: false })).toBe(true);
  });
});

describe('surfaceVisibility — what decides it', () => {
  it('reads structure alone, not layer', () => {
    // The regression guard for the underpass change: layer is ordering evidence the
    // elevation profile reads, and must not decide again whether a surface is drawn.
    for (const layer of [-3, -2, -1, 0, 1, 2, 3]) {
      expect(surfaceVisibility({ structure: 'ground', layer })).toBe('visible');
      expect(surfaceVisibility({ structure: 'ford', layer })).toBe('visible');
      expect(surfaceVisibility({ structure: 'tunnel', layer })).toBe('hidden');
      expect(surfaceVisibility({ structure: 'bridge', layer })).toBe('visible');
    }
  });

  it('still hides tunnels, which is the case the caution was actually for', () => {
    // A tunnel IS dug down by the profile and has no portal or cut geometry to be seen
    // through, so painting its ribbon would lay a road across whatever covers it.
    expect(surfaceVisibility(road({ structure: 'tunnel' }))).toBe('hidden');
    expect(isSurfaceVisible(road({ structure: 'tunnel' }))).toBe(false);
  });
});
