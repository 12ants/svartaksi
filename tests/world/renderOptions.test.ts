import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER_OPTIONS,
  RENDER_OPTIONS_STORAGE_KEY,
  loadRenderOptions,
  normalizeRenderOptions,
  fogDensityFor,
  resolveEffectiveRenderQuality,
  saveRenderOptions,
  shadowQualityFor,
} from '../../src/world/renderOptions';
import { shadowTexelSize } from '../../src/world/shadowSnap';

describe('render options', () => {
  it('normalizes valid fields and falls back invalid fields independently', () => {
    expect(normalizeRenderOptions({ quality: 'high', water: false, roads: 'no' })).toEqual({
      ...DEFAULT_RENDER_OPTIONS,
      quality: 'high',
      water: false,
    });
  });

  it('loads defaults from malformed storage and persists valid options', () => {
    expect(loadRenderOptions({ getItem: () => '{bad json' })).toEqual(DEFAULT_RENDER_OPTIONS);
    const setItem = vi.fn();
    const options = { ...DEFAULT_RENDER_OPTIONS, buildings: false };
    saveRenderOptions({ setItem }, options);
    expect(setItem).toHaveBeenCalledWith(RENDER_OPTIONS_STORAGE_KEY, JSON.stringify(options));
  });

  it('normalizes and persists cinematic material and shadow preferences', () => {
    const options = normalizeRenderOptions({ cinematicMaterials: false, highQualityShadows: false });
    expect(options.cinematicMaterials).toBe(false);
    expect(options.highQualityShadows).toBe(false);
  });

  it('migrates old stored payloads with balanced defaults for new controls', () => {
    const options = normalizeRenderOptions({ quality: 'high', water: false });

    expect(options).toMatchObject({
      streetLights: true,
      facadeDetails: true,
      dynamicResolution: true,
    });
  });

  it('defaults the hidden-roads debug override off and normalizes it like any other flag', () => {
    expect(DEFAULT_RENDER_OPTIONS.debugShowHiddenRoads).toBe(false);
    expect(normalizeRenderOptions({ debugShowHiddenRoads: true }).debugShowHiddenRoads).toBe(true);
    // Malformed input falls back to the default rather than propagating garbage.
    expect(normalizeRenderOptions({ debugShowHiddenRoads: 'yes' }).debugShowHiddenRoads).toBe(false);
  });

  it('derives one bounded effective configuration for every quality tier', () => {
    for (const quality of ['performance', 'balanced', 'high'] as const) {
      const effective = resolveEffectiveRenderQuality({
        ...DEFAULT_RENDER_OPTIONS,
        quality,
      }, 0.1);
      expect(effective.pixelRatioCap).toBeGreaterThan(0);
      expect(effective.facadeInstances).toBeGreaterThan(0);
      expect(effective.buildingDistance).toBeGreaterThan(0);
      expect(effective.streetLightInstances).toBeGreaterThanOrEqual(0);
    }

    const performance = resolveEffectiveRenderQuality({
      ...DEFAULT_RENDER_OPTIONS,
      quality: 'performance',
    }, 1);
    expect(performance).toMatchObject({
      shadows: false,
      secondaryDetails: false,
      cinematicMaterials: false,
    });
  });

  it('applies user flags and clamps adaptive scale from 0.35 to 1', () => {
    const disabled = resolveEffectiveRenderQuality({
      ...DEFAULT_RENDER_OPTIONS,
      cinematicMaterials: false,
      highQualityShadows: false,
      streetLights: false,
      facadeDetails: false,
      dynamicResolution: false,
    }, 2);
    const low = resolveEffectiveRenderQuality(DEFAULT_RENDER_OPTIONS, 0);

    expect(disabled).toMatchObject({
      cinematicMaterials: false,
      streetLightInstances: 0,
      secondaryDetails: false,
    });
    expect(disabled.pixelRatioCap).toBe(1.5);
    expect(low.facadeInstances).toBe(Math.round(5_000 * 0.35));
    expect(low.buildingDistance).toBe(Math.round(500 * 0.35));
    expect(low.secondaryDetails).toBe(false);
  });

  it('uses tighter and more detailed shadows at higher quality', () => {
    expect(shadowQualityFor('performance').mapSize).toBeLessThan(shadowQualityFor('balanced').mapSize);
    expect(shadowQualityFor('high').extent).toBeGreaterThan(shadowQualityFor('balanced').extent);
    expect(shadowQualityFor('high').normalBias).toBeLessThan(shadowQualityFor('performance').normalBias);
  });

  it('keeps the shadow penumbra roughly the same width in world meters at every tier', () => {
    // radius is in shadow-map texels, and a texel is a different number of meters at
    // every tier. Scaling radius with texel size is what stops a quality change from
    // also silently changing how soft every shadow in the scene looks.
    const penumbra = (quality: 'performance' | 'balanced' | 'high') => {
      const { radius, extent, mapSize } = shadowQualityFor(quality);
      return radius * shadowTexelSize(extent, mapSize);
    };
    const widths = (['performance', 'balanced', 'high'] as const).map(penumbra);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1);
  });

  it('drops any tier to the cheapest shadow settings when high-quality shadows are off', () => {
    // The HUD exposes this toggle; before it resolved here it was read by nothing.
    for (const quality of ['performance', 'balanced', 'high'] as const) {
      expect(shadowQualityFor(quality, false)).toEqual(shadowQualityFor('performance'));
    }
    expect(shadowQualityFor('high', true)).not.toEqual(shadowQualityFor('performance'));
  });

  it('thickens the fog as the draw distance is pulled in', () => {
    // Buildings are hard-cut at their draw distance and fog is the only thing hiding
    // that cut, so a slower machine — which gets a shorter distance from the render
    // budget — has to get a hazier city rather than buildings winking out of clear air.
    const near = fogDensityFor(500);
    const far = fogDensityFor(1_200);
    expect(near).toBeGreaterThan(far);

    // Same opacity at whatever distance the cut lands on: 1 - exp(-(density * d)^2).
    const opacityAt = (distance: number) => 1 - Math.exp(-((fogDensityFor(distance) * distance) ** 2));
    expect(opacityAt(700)).toBeCloseTo(opacityAt(950), 2);
  });

  it('keeps the fog inside sane bounds however extreme the draw distance', () => {
    expect(fogDensityFor(10_000)).toBeGreaterThan(0);
    // A machine at the floor of the render budget must not end up fogged in at arm's
    // length, and a degenerate distance must not produce a NaN density.
    expect(fogDensityFor(1)).toBeLessThan(0.01);
    expect(Number.isFinite(fogDensityFor(0))).toBe(true);
    expect(Number.isFinite(fogDensityFor(-5))).toBe(true);
  });

  it('follows the render budget down: a struggling machine sees more fog', () => {
    const options = { ...DEFAULT_RENDER_OPTIONS };
    const healthy = resolveEffectiveRenderQuality(options, 1);
    const struggling = resolveEffectiveRenderQuality(options, 0.35);
    expect(struggling.buildingDistance).toBeLessThan(healthy.buildingDistance);
    expect(fogDensityFor(struggling.buildingDistance))
      .toBeGreaterThan(fogDensityFor(healthy.buildingDistance));
  });
});

describe('terrain settings', () => {
  it('ships with the relief switched on', () => {
    expect(DEFAULT_RENDER_OPTIONS.terrain.enabled).toBe(true);
    expect(DEFAULT_RENDER_OPTIONS.terrain.scale).toBe(1);
    expect(DEFAULT_RENDER_OPTIONS.terrain.slope).toBeGreaterThan(0);
  });

  it('round-trips through storage', () => {
    const stored = JSON.stringify({ ...DEFAULT_RENDER_OPTIONS, terrain: { enabled: false, scale: 2, slope: 3 } });
    expect(normalizeRenderOptions(JSON.parse(stored)).terrain).toEqual({ enabled: false, scale: 2, slope: 3 });
  });

  it('repairs a stored value that is out of range or missing', () => {
    expect(normalizeRenderOptions({}).terrain).toEqual(DEFAULT_RENDER_OPTIONS.terrain);
    expect(normalizeRenderOptions({ terrain: { scale: 500 } }).terrain.scale).toBeLessThanOrEqual(8);
  });
});

it('clamps facade controls and rejects non-finite persisted values', () => {
  const options = normalizeRenderOptions({ windowBrightness: 99, windowOccupancy: -1, windowWarmth: NaN, windowCastLight: true });
  expect(options.windowBrightness).toBe(3);
  expect(options.windowOccupancy).toBe(0);
  expect(options.windowWarmth).toBe(0);
  expect(options.windowCastLight).toBe(true);
});
