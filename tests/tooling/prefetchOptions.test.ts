import { describe, expect, it } from 'vitest';
import { parseOptions, usage } from '../../scripts/lib/prefetchOptions.mjs';

describe('parseOptions', () => {
  it('returns defaults with no arguments', () => {
    const options = parseOptions([]);
    expect(options).toEqual({
      areas: 'all',
      emit: 'both',
      zoom: 14,
      radiusTerrain: 1_500,
      radiusBuildings: 560,
      precisionCm: 1,
      maxTiles: 32,
      corridorMaxTiles: 48,
      concurrency: 8,
      outputDir: 'vendor/worldcache',
      origin: null,
      offline: false,
      dryRun: false,
    });
  });

  it('returns { help: true } for --help and prints usage', () => {
    expect(parseOptions(['--help'])).toEqual({ help: true });
    expect(usage()).toContain('--areas');
    expect(usage()).toContain('--offline');
  });

  it('parses --areas as a comma-separated list', () => {
    expect(parseOptions(['--areas', 'svartaksi,krukmakargatan']).areas)
      .toEqual(['svartaksi', 'krukmakargatan']);
  });

  it('rejects an unknown --emit value', () => {
    expect(() => parseOptions(['--emit', 'nonsense']))
      .toThrow('--emit must be one of tiles, world, both');
  });

  it('rejects a non-numeric --zoom', () => {
    expect(() => parseOptions(['--zoom', 'abc'])).toThrow('--zoom must be a positive integer');
  });

  it('rejects a malformed --origin', () => {
    expect(() => parseOptions(['--origin', '18.16'])).toThrow('--origin must be LNG,LAT');
  });

  it('parses a well-formed --origin', () => {
    expect(parseOptions(['--origin', '18.1637,59.3103']).origin).toEqual({ lng: 18.1637, lat: 59.3103 });
  });

  it('sets boolean flags without consuming a value', () => {
    const options = parseOptions(['--offline', '--dry-run']);
    expect(options.offline).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseOptions(['--nope'])).toThrow('Unknown option: --nope');
  });

  it('rejects a flag missing its value', () => {
    expect(() => parseOptions(['--zoom'])).toThrow('--zoom requires a value');
  });
});
