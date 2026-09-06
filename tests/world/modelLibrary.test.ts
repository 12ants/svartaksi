import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_MODELS,
  listRemoteModels,
  modelFileUrl,
  modelFitTransform,
  modelLabel,
  modelListingUrl,
  parseModelListing,
} from '../../src/world/modelLibrary';

describe('model URLs', () => {
  it('points at raw.githubusercontent, which is the only host that serves these with CORS', () => {
    const url = modelFileUrl('kermit_the_frog.glb');
    expect(url).toBe('https://raw.githubusercontent.com/12ants/models/main/kermit_the_frog.glb');
    expect(modelListingUrl()).toContain('api.github.com/repos/12ants/models/contents');
  });

  it('escapes a name that would otherwise break the URL', () => {
    expect(modelFileUrl('a b&c.glb')).toContain('a%20b%26c.glb');
  });
});

describe('modelLabel', () => {
  it('turns a repository file name into something readable', () => {
    expect(modelLabel('kermit_the_frog_dancing_4.glb')).toBe('Kermit the frog dancing 4');
    expect(modelLabel('lowpoly_bus-optimized.glb')).toBe('Lowpoly bus optimized');
    expect(modelLabel('4818.glb')).toBe('4818');
  });

  it('falls back to the file name rather than an empty label', () => {
    expect(modelLabel('.glb')).toBe('.glb');
  });
});

describe('parseModelListing', () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, type: 'file', size: 1024, ...extra });

  it('keeps only .glb files, sorted by name', () => {
    const models = parseModelListing([
      entry('zebra.glb'), entry('README.md'), entry('alpha.glb'),
      entry('nested', { type: 'dir' }),
    ]);
    expect(models.map((model) => model.fileName)).toEqual(['alpha.glb', 'zebra.glb']);
    expect(models[0].bytes).toBe(1024);
  });

  it('survives a payload it does not understand rather than throwing into a render', () => {
    // Third-party JSON crossing a trust boundary: an unexpected shape must degrade to an
    // empty catalogue (and therefore the fallback), never an exception.
    for (const payload of [null, undefined, {}, 'nope', [null], [{ name: 5, type: 'file' }], [{}]]) {
      expect(() => parseModelListing(payload)).not.toThrow();
      expect(parseModelListing(payload)).toEqual([]);
    }
  });

  it('tolerates a missing size', () => {
    expect(parseModelListing([entry('a.glb', { size: undefined })])[0].bytes).toBeNull();
  });
});

describe('listRemoteModels', () => {
  it('uses the live listing when the repository answers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'fresh.glb', type: 'file', size: 10 }],
    });
    const result = await listRemoteModels(fetchImpl as unknown as typeof fetch);
    expect(result.discovered).toBe(true);
    expect(result.models.map((model) => model.fileName)).toEqual(['fresh.glb']);
  });

  it('falls back rather than rejecting, whatever went wrong', async () => {
    // Offline, rate-limited and nonsense-payload all land in the same place: an empty
    // picker with no explanation is worse than last-known-good contents.
    const cases = [
      vi.fn().mockRejectedValue(new Error('offline')),
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
      vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json'); } }),
    ];
    for (const fetchImpl of cases) {
      const result = await listRemoteModels(fetchImpl as unknown as typeof fetch);
      expect(result.discovered).toBe(false);
      expect(result.models).toBe(FALLBACK_MODELS);
    }
  });

  it('ships a fallback that is actually usable', () => {
    expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
    for (const model of FALLBACK_MODELS) {
      expect(model.fileName).toMatch(/\.glb$/);
      expect(model.url).toContain(model.fileName);
      expect(model.label).not.toBe('');
    }
  });
});

describe('modelFitTransform', () => {
  // A library anyone can drop a .glb into has no shared convention for scale or origin.
  it('scales the longest side to the target and stands the model on the ground, centred', () => {
    // Extents 4 x 4 x 4 here, so every axis agrees on the scale and the offsets are the
    // thing under test.
    const fit = modelFitTransform({ x: 10, y: 4, z: -2 }, { x: 14, y: 8, z: 2 }, 3);
    expect(fit.scale).toBeCloseTo(3 / 4, 6);
    // Base at exactly y=0 after the transform, so the caller places it by ground height.
    expect(4 * fit.scale + fit.offsetY).toBeCloseTo(0, 6);
    // Horizontally centred on the origin.
    expect(((10 + 14) / 2) * fit.scale + fit.offsetX).toBeCloseTo(0, 6);
    expect(((-2 + 2) / 2) * fit.scale + fit.offsetZ).toBeCloseTo(0, 6);
  });

  it('brings a centimetre-scale export and a 40-unit one into the same envelope', () => {
    const tiny = modelFitTransform({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 1 }, 3);
    const huge = modelFitTransform({ x: 0, y: 0, z: 0 }, { x: 20, y: 40, z: 20 }, 3);
    expect(2 * tiny.scale).toBeCloseTo(3, 6);
    expect(40 * huge.scale).toBeCloseTo(3, 6);
  });

  it('fits a wide, flat model by its length rather than stretching it by its height', () => {
    // The bug this rule replaced: a car is ~1.5m high and ~4m long, so height-fitting it to
    // 3m produced a twelve-metre limousine towering over the bus beside it.
    const car = modelFitTransform({ x: -2, y: 0, z: -0.9 }, { x: 2, y: 1.5, z: 0.9 }, 4);
    expect(4 * car.scale).toBeCloseTo(4, 6);
    expect(1.5 * car.scale).toBeCloseTo(1.5, 6);
  });

  it('refuses to produce NaN for a degenerate or broken box', () => {
    // A NaN transform removes the model from the scene graph's bounds and it silently
    // never appears — the worst failure mode for a spawn button.
    for (const [min, max] of [
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
      [{ x: 0, y: Infinity, z: 0 }, { x: 0, y: -Infinity, z: 0 }],
      [{ x: 0, y: NaN, z: 0 }, { x: 0, y: NaN, z: 0 }],
    ] as const) {
      const fit = modelFitTransform(min, max, 3);
      for (const value of [fit.scale, fit.offsetX, fit.offsetY, fit.offsetZ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(fit.scale).toBe(1);
    }
  });
});
