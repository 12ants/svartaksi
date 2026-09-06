import { describe, expect, it } from 'vitest';
import { BUS_CORRIDOR_PAD_METERS, worldCacheKey } from '../../src/svartaksi/svartaksiRuntime';
import { OPENING_RIDE, START_LOCATION, WORLD_DATA_RADIUS } from '../../src/svartaksi/config';

// Mirrors worldCacheKey's own grid, not a plain decimal round — a raw `.toFixed(3)`
// only coincidentally matches the quantized value for some coordinates and silently
// diverges for others (WORLD_CACHE_GRID_DEGREES is 0.002, not 0.001).
const WORLD_CACHE_GRID_DEGREES = 0.002;
const quantize = (value: number) =>
  (Math.round(value / WORLD_CACHE_GRID_DEGREES) * WORLD_CACHE_GRID_DEGREES).toFixed(3);

describe('worldCacheKey', () => {
  it('quantizes a radial centre onto the cache grid', () => {
    const key = worldCacheKey('maplibre', START_LOCATION);
    expect(key).toBe(
      `maplibre:${quantize(START_LOCATION.lng)}:${quantize(START_LOCATION.lat)}:` +
      `${WORLD_DATA_RADIUS.buildings}:${WORLD_DATA_RADIUS.terrain}`,
    );
  });

  it('is stable for two centres that quantize to the same grid cell', () => {
    const a = worldCacheKey('maplibre', START_LOCATION);
    const b = worldCacheKey('maplibre', { lng: START_LOCATION.lng + 0.0001, lat: START_LOCATION.lat });
    expect(a).toBe(b);
  });

  it('includes a distinct corridor suffix', () => {
    const key = worldCacheKey('maplibre', OPENING_RIDE.from, {
      from: OPENING_RIDE.from,
      to: OPENING_RIDE.to,
      padMeters: BUS_CORRIDOR_PAD_METERS,
    });
    expect(key).toContain(':corridor:');
    expect(key).not.toBe(worldCacheKey('maplibre', OPENING_RIDE.from));
  });

  it('BUS_CORRIDOR_PAD_METERS matches WORLD_DATA_RADIUS.buildings', () => {
    expect(BUS_CORRIDOR_PAD_METERS).toBe(WORLD_DATA_RADIUS.buildings);
  });
});
