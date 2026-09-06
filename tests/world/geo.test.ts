import { describe, expect, it } from 'vitest';
import {
  getChunkKeys,
  getCorridorChunkKeys,
  lngLatToLocal,
  lngLatToTile,
  localToLngLat,
  ringCentroid,
  smoothPolyline,
  withinLocalCorridor,
  withinLocalRadius,
} from '../../src/world/geo';

describe('world geography', () => {
  it('round trips Stockholm coordinates through local meters', () => {
    const origin = { lng: 18.0686, lat: 59.3293 };
    const point = { lng: 18.075, lat: 59.332 };
    const local = lngLatToLocal(origin, point);
    const result = localToLngLat(origin, local);

    expect(result.lng).toBeCloseTo(point.lng, 6);
    expect(result.lat).toBeCloseTo(point.lat, 6);
  });

  it('selects deterministic unique chunks around a location', () => {
    const keys = getChunkKeys({ lng: 18.0686, lat: 59.3293 }, 900, 15);
    const ids = keys.map(({ z, x, y }) => `${z}/${x}/${y}`);

    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getChunkKeys({ lng: 18.0686, lat: 59.3293 }, 900, 15)).toEqual(keys);
  });
});

describe('getCorridorChunkKeys', () => {
  // The opening ride: Svartaksi Forum to Krukmakargatan, about 6km west across Stockholm.
  const svartaksi = { lng: 18.1637, lat: 59.3103 };
  const krukmakargatan = { lng: 18.0553, lat: 59.3175 };
  const id = ({ z, x, y }: { z: number; x: number; y: number }) => `${z}/${x}/${y}`;

  it('covers both endpoints of the route', () => {
    const keys = getCorridorChunkKeys(svartaksi, krukmakargatan, 700, 14).map(id);

    expect(keys).toContain(id(lngLatToTile(svartaksi, 14)));
    expect(keys).toContain(id(lngLatToTile(krukmakargatan, 14)));
  });

  it('covers a point midway along the route', () => {
    const midway = {
      lng: (svartaksi.lng + krukmakargatan.lng) / 2,
      lat: (svartaksi.lat + krukmakargatan.lat) / 2,
    };
    expect(getCorridorChunkKeys(svartaksi, krukmakargatan, 700, 14).map(id))
      .toContain(id(lngLatToTile(midway, 14)));
  });

  it('costs far fewer tiles than the disc that would have to cover the same route', () => {
    const corridor = getCorridorChunkKeys(svartaksi, krukmakargatan, 700, 14);
    // What a radial fetch needs to reach both ends: half the span, plus the same pad.
    const disc = getChunkKeys(
      { lng: (svartaksi.lng + krukmakargatan.lng) / 2, lat: (svartaksi.lat + krukmakargatan.lat) / 2 },
      3_800,
      14,
    );

    expect(corridor.length).toBeGreaterThan(0);
    expect(corridor.length).toBeLessThan(disc.length / 2);
  });

  it('returns unique, deterministic keys ordered from the start of the route outward', () => {
    const keys = getCorridorChunkKeys(svartaksi, krukmakargatan, 700, 14);

    expect(new Set(keys.map(id)).size).toBe(keys.length);
    expect(getCorridorChunkKeys(svartaksi, krukmakargatan, 700, 14)).toEqual(keys);
    // A fetch cap has to leave the near end of the journey intact, so that end comes first.
    expect(id(keys[0])).toBe(id(lngLatToTile(svartaksi, 14)));
    expect(id(keys.at(-1)!)).not.toBe(id(lngLatToTile(svartaksi, 14)));
  });

  it('still returns the tile a zero-length route sits on', () => {
    expect(getCorridorChunkKeys(svartaksi, svartaksi, 0, 14).map(id)).toContain(id(lngLatToTile(svartaksi, 14)));
  });
});

describe('smoothPolyline', () => {
  it('leaves a straight two-point line untouched', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0 }];
    expect(smoothPolyline(points)).toEqual(points);
  });

  it('keeps the exact start/end points fixed while cutting corners in between', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
    const smoothed = smoothPolyline(points);

    expect(smoothed[0]).toEqual(points[0]);
    expect(smoothed.at(-1)).toEqual(points.at(-1));
    expect(smoothed.length).toBeGreaterThan(points.length);
    // The sharp 90° corner itself should no longer appear as a vertex — that's the point.
    expect(smoothed.some(p => p.x === 10 && p.z === 0)).toBe(false);
  });

  it('defaults to two passes — noticeably rounder than a single pass', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
    const onePass = smoothPolyline(points, 1);
    const defaultPasses = smoothPolyline(points);
    expect(defaultPasses.length).toBeGreaterThan(onePass.length);
    expect(defaultPasses[0]).toEqual(points[0]);
    expect(defaultPasses.at(-1)).toEqual(points.at(-1));
  });

  it('supports zero passes as a literal no-op', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
    expect(smoothPolyline(points, 0)).toEqual(points);
  });

  it('leaves a straight run alone instead of subdividing it', () => {
    // Every vertex here is collinear: there is no corner to round, so rounding it would
    // only multiply the vertex count of the ribbon, the graph and the build.
    const straight = Array.from({ length: 9 }, (_, index) => ({ x: index * 10, z: 0 }));
    expect(smoothPolyline(straight)).toEqual(straight);

    // The same run with one real bend keeps its straight part and cuts only the bend.
    const bent = [...straight, { x: 80, z: 40 }];
    const smoothed = smoothPolyline(bent);
    expect(smoothed.length).toBeLessThan(bent.length * 2);
    expect(smoothed.some((point) => point.x === 80 && point.z === 0)).toBe(false);
    expect(smoothed.slice(0, 8)).toEqual(straight.slice(0, 8));
  });

  it('ignores the sub-degree wobble tile quantization leaves on a straight street', () => {
    const wobbly = Array.from({ length: 9 }, (_, index) => ({ x: index * 10, z: index % 2 ? 0.01 : 0 }));
    expect(smoothPolyline(wobbly)).toEqual(wobbly);
  });

  it('survives a polyline with repeated points', () => {
    const repeated = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }];
    const smoothed = smoothPolyline(repeated);
    expect(smoothed[0]).toEqual(repeated[0]);
    expect(smoothed.at(-1)).toEqual(repeated.at(-1));
    for (const point of smoothed) {
      expect([Number.isFinite(point.x), Number.isFinite(point.z)]).toEqual([true, true]);
    }
  });
});

describe('withinLocalRadius', () => {
  it('accepts points inside the radius and rejects points outside it', () => {
    const center = { x: 0, z: 0 };
    expect(withinLocalRadius({ x: 3, z: 4 }, center, 5)).toBe(true);
    expect(withinLocalRadius({ x: 3, z: 4.01 }, center, 5)).toBe(false);
  });
});

describe('withinLocalCorridor', () => {
  it('accepts a point next to the line and rejects one further off it', () => {
    const from = { x: 0, z: 0 };
    const to = { x: 100, z: 0 };
    expect(withinLocalCorridor({ x: 50, z: 4 }, from, to, 5)).toBe(true);
    expect(withinLocalCorridor({ x: 50, z: 5.01 }, from, to, 5)).toBe(false);
  });

  it('measures from the nearest point on the segment, not just its endpoints', () => {
    const from = { x: 0, z: 0 };
    const to = { x: 100, z: 0 };
    // Well past the far end laterally-close would fail on distance-to-endpoint alone.
    expect(withinLocalCorridor({ x: 200, z: 0 }, from, to, 5)).toBe(false);
  });

  it('falls back to distance from the point when from and to coincide', () => {
    const point = { x: 0, z: 0 };
    expect(withinLocalCorridor({ x: 3, z: 4 }, point, point, 5)).toBe(true);
    expect(withinLocalCorridor({ x: 3, z: 4.01 }, point, point, 5)).toBe(false);
  });
});

describe('ringCentroid', () => {
  it('averages a ring of points', () => {
    expect(ringCentroid([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }])).toEqual({ x: 5, z: 5 });
  });

  it('returns the origin for an empty ring', () => {
    expect(ringCentroid([])).toEqual({ x: 0, z: 0 });
  });
});
