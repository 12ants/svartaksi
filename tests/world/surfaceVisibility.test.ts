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

  it('hides fully-covered/underpass ground roads (negative layer, no bridge/tunnel tag) as the conservative fallback', () => {
    // This world has no open-surface geometry for underpasses yet (item 8 deferred
    // deck/pier/portal meshes) — hiding rather than drawing a surface that doesn't exist.
    expect(surfaceVisibility(road({ structure: 'ground', layer: -1 }))).toBe('hidden');
    expect(surfaceVisibility(road({ layer: -2 }))).toBe('hidden');
  });

  it('treats ford like ground for visibility purposes', () => {
    expect(surfaceVisibility(road({ structure: 'ford', layer: 0 }))).toBe('visible');
    expect(surfaceVisibility(road({ structure: 'ford', layer: -1 }))).toBe('hidden');
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
