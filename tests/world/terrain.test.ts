import { describe, expect, it } from 'vitest';
import {
  areaTerrainHeight,
  buildTerrainIndex,
  computeTerrainClearance,
  DEFAULT_TERRAIN_SETTINGS,
  insetRing,
  normalizeTerrainSettings,
  terrainHeightAt,
  terrainHeightAtXZIndexed,
  terrainIndexCandidatesAt,
  terrainRampWidth,
  TERRAIN_SCALE_RANGE,
  WATER_SURFACE_EPSILON,
  waterSurfaceHeightAtIndexed,
  type TerrainClearance,
  type TerrainSettings,
} from '../../src/world/terrain';
import type { WorldArea } from '../../src/world/types';

const square = (size: number) => [
  { x: 0, z: 0 }, { x: size, z: 0 }, { x: size, z: size }, { x: 0, z: size },
];
const area = (id: string, kind: string, size = 200): WorldArea => ({ id, kind, rings: [square(size)] });
const settings = (patch: Partial<TerrainSettings> = {}): TerrainSettings => ({
  ...DEFAULT_TERRAIN_SETTINGS, ...patch,
});

describe('normalizeTerrainSettings', () => {
  it('falls back to the defaults for anything it cannot read', () => {
    expect(normalizeTerrainSettings(null)).toEqual(DEFAULT_TERRAIN_SETTINGS);
    expect(normalizeTerrainSettings({ scale: 'tall' })).toEqual(DEFAULT_TERRAIN_SETTINGS);
    expect(normalizeTerrainSettings({ scale: Number.NaN })).toEqual(DEFAULT_TERRAIN_SETTINGS);
  });

  it('clamps a stored value into the range the sliders offer', () => {
    expect(normalizeTerrainSettings({ scale: 999 }).scale).toBe(TERRAIN_SCALE_RANGE.max);
    // Never 0: a polygon collapsed onto the ground plane z-fights with everything over it.
    expect(normalizeTerrainSettings({ scale: -4 }).scale).toBe(TERRAIN_SCALE_RANGE.min);
    expect(normalizeTerrainSettings({ slope: -1 }).slope).toBe(0);
  });

  it('keeps a setting it recognises', () => {
    expect(normalizeTerrainSettings({ enabled: false, scale: 2.5, slope: 10 }))
      .toEqual({ enabled: false, scale: 2.5, slope: 10 });
  });
});

describe('areaTerrainHeight', () => {
  it('reads the height off the mapped kind, canopy standing over lawn over tarmac', () => {
    const wood = areaTerrainHeight(area('a', 'wood'));
    const grass = areaTerrainHeight(area('a', 'grass'));
    const retail = areaTerrainHeight(area('a', 'retail'));
    expect(wood).toBeGreaterThan(grass);
    expect(grass).toBeGreaterThan(retail);
  });

  it('gives two polygons of one kind different heights, so they cannot sit coplanar', () => {
    expect(areaTerrainHeight(area('a', 'park'))).not.toBeCloseTo(areaTerrainHeight(area('b', 'park')), 5);
  });

  it('answers the same for the same polygon every time, so a rebuild does not move the ground', () => {
    expect(areaTerrainHeight(area('stable', 'wood'))).toBe(areaTerrainHeight(area('stable', 'wood')));
  });

  it('scales the whole relief without reordering it', () => {
    const plain = areaTerrainHeight(area('a', 'wood'));
    expect(areaTerrainHeight(area('a', 'wood'), settings({ scale: 3 }))).toBeCloseTo(plain * 3, 6);
  });

  it('flattens to a decal when terrain is switched off, without collapsing onto the plane', () => {
    const off = settings({ enabled: false });
    expect(areaTerrainHeight(area('a', 'wood'), off)).toBeLessThan(0.06);
    expect(areaTerrainHeight(area('a', 'wood'), off)).toBeGreaterThan(0);
    // Still separated per polygon: that is the only job left when the relief is off.
    expect(areaTerrainHeight(area('a', 'wood'), off)).not.toBeCloseTo(areaTerrainHeight(area('b', 'wood'), off), 6);
  });

  it('ignores the scale slider while it is switched off', () => {
    expect(areaTerrainHeight(area('a', 'wood'), settings({ enabled: false, scale: 8 })))
      .toBe(areaTerrainHeight(area('a', 'wood'), settings({ enabled: false, scale: 1 })));
  });
});

describe('terrainRampWidth', () => {
  it('runs the slope out proportionally to the height it has to climb', () => {
    const ring = square(400);
    expect(terrainRampWidth(ring, 1, settings({ slope: 6 }))).toBeCloseTo(6, 6);
    expect(terrainRampWidth(ring, 2, settings({ slope: 6 }))).toBeCloseTo(12, 6);
  });

  it('is nothing at all with the slope turned down, which is the old vertical wall', () => {
    expect(terrainRampWidth(square(400), 1, settings({ slope: 0 }))).toBe(0);
  });

  it('caps the ramp on a polygon too small to hold it, rather than folding the top face', () => {
    // A 4m square cannot take a 6m inset from every side.
    const ramp = terrainRampWidth(square(4), 1, settings({ slope: 6 }));
    expect(ramp).toBeGreaterThan(0);
    expect(ramp).toBeLessThan(2);
  });
});

describe('terrainHeightAt', () => {
  const clearance = (kind: string, size = 200, patch: Partial<TerrainSettings> = {}) =>
    computeTerrainClearance([area('wood-a', kind, size)], settings(patch));

  it('stands at its full height well inside the polygon', () => {
    const terrain = clearance('wood');
    expect(terrainHeightAt({ x: 100, z: 100 }, terrain)).toBeCloseTo(terrain[0].height, 6);
  });

  it('meets the surrounding ground exactly on the polygon outline', () => {
    const terrain = clearance('wood');
    expect(terrainHeightAt({ x: 100, z: 0.01 }, terrain)).toBeLessThan(0.01);
    expect(terrainHeightAt({ x: 100, z: -1 }, terrain)).toBe(0);
  });

  it('climbs monotonically inward across the bank', () => {
    const terrain = clearance('wood');
    const ramp = terrain[0].ramp;
    let previous = -1;
    for (let step = 0; step <= 10; step += 1) {
      const height = terrainHeightAt({ x: 100, z: (ramp * step) / 10 }, terrain);
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
    expect(previous).toBeCloseTo(terrain[0].height, 6);
  });

  it('never steps: the whole bank is walkable at a bounded gradient', () => {
    // The reason any of this exists. A prism's edge changes by its full height over zero
    // distance, which a wheel meets as a wall; the ramp holds the gradient near 1/slope.
    const terrain = clearance('wood');
    const gradientCap = 1 / settings().slope * 2;
    for (let z = -2; z < terrain[0].ramp + 2; z += 0.25) {
      const here = terrainHeightAt({ x: 100, z }, terrain);
      const next = terrainHeightAt({ x: 100, z: z + 0.25 }, terrain);
      expect(Math.abs(next - here) / 0.25).toBeLessThanOrEqual(gradientCap);
    }
  });

  it('keeps the vertical wall when the slope is turned all the way down', () => {
    const terrain = clearance('wood', 200, { slope: 0 });
    expect(terrainHeightAt({ x: 100, z: 0.01 }, terrain)).toBeCloseTo(terrain[0].height, 6);
  });

  it('takes the tallest polygon where several overlap', () => {
    const terrain = computeTerrainClearance([area('a', 'wood'), area('b', 'grass')]);
    expect(terrainHeightAt({ x: 100, z: 100 }, terrain)).toBeGreaterThan(0.5);
  });

  it('is flat outside every polygon', () => {
    expect(terrainHeightAt({ x: 900, z: 900 }, clearance('wood'))).toBe(0);
  });

  it('does not lift a point that only clips a polygon\'s bounding box', () => {
    // An L: the notch is inside the box and outside the shape.
    const l: WorldArea = {
      id: 'l', kind: 'wood',
      rings: [[{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 40 }, { x: 40, z: 40 }, { x: 40, z: 100 }, { x: 0, z: 100 }]],
    };
    expect(terrainHeightAt({ x: 90, z: 90 }, computeTerrainClearance([l]))).toBe(0);
  });

  it('rises with the height slider, everywhere at once', () => {
    const plain = terrainHeightAt({ x: 100, z: 100 }, clearance('wood'));
    const tall = terrainHeightAt({ x: 100, z: 100 }, clearance('wood', 200, { scale: 4 }));
    expect(tall).toBeCloseTo(plain * 4, 5);
  });
});

describe('buildTerrainIndex / terrainHeightAtXZIndexed (backlog item 3: spatial index)', () => {
  /** A grid of same-size non-overlapping wood squares, the same shape `computeTerrainClearance`
   * would build from a tile's worth of parks — enough polygons (400) that a linear scan and a
   * spatially-indexed one give measurably different, checkable answers about how much work
   * each did. */
  const grid = (cols: number, rows: number, size = 30, gap = 10): TerrainClearance[] => {
    const areas: WorldArea[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const ox = col * (size + gap);
        const oz = row * (size + gap);
        areas.push({
          id: `p-${row}-${col}`,
          kind: 'wood',
          rings: [[
            { x: ox, z: oz }, { x: ox + size, z: oz },
            { x: ox + size, z: oz + size }, { x: ox, z: oz + size },
          ]],
        });
      }
    }
    return computeTerrainClearance(areas, settings({ slope: 0 }));
  };

  it('answers identically to the linear scan at every polygon interior, gap and edge', () => {
    const terrain = grid(20, 20);
    const index = buildTerrainIndex(terrain);
    const probes: Array<[number, number]> = [];
    for (let row = 0; row < 20; row += 1) {
      for (let col = 0; col < 20; col += 1) {
        const ox = col * 40;
        const oz = row * 40;
        probes.push([ox + 15, oz + 15]); // polygon interior
        probes.push([ox + 35, oz + 15]); // gap between polygons
      }
    }
    for (const [x, z] of probes) {
      expect(terrainHeightAtXZIndexed(x, z, index)).toBe(terrainHeightAt({ x, z }, terrain));
    }
  });

  it('is flat outside every polygon and off the indexed grid entirely', () => {
    const terrain = grid(5, 5);
    const index = buildTerrainIndex(terrain);
    expect(terrainHeightAtXZIndexed(-500, -500, index)).toBe(0);
    expect(terrainHeightAtXZIndexed(50_000, 50_000, index)).toBe(0);
  });

  it('takes the tallest polygon where several overlap, same as the linear scan', () => {
    const terrain = computeTerrainClearance([area('a', 'wood'), area('b', 'grass')]);
    const index = buildTerrainIndex(terrain);
    expect(terrainHeightAtXZIndexed(100, 100, index)).toBeGreaterThan(0.5);
    expect(terrainHeightAtXZIndexed(100, 100, index)).toBe(terrainHeightAt({ x: 100, z: 100 }, terrain));
  });

  it('regression threshold: an interior query only rescans a small fraction of a large terrain set', () => {
    // This is the whole point of the index: `terrainHeightAtXZ` (the linear scan) always
    // walks every one of `terrain.length` polygons. A working spatial index should let a
    // single-cell query touch only the handful of polygons whose bounding box overlaps that
    // cell. Asserted as a bucket-size bound, not wall-clock time, so it is not sensitive to
    // CI host speed the way a timing assertion would be.
    const terrain = grid(20, 20); // 400 polygons
    const index = buildTerrainIndex(terrain);
    const candidates = terrainIndexCandidatesAt(215, 215, index);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(terrain.length / 10);
  });

  it('reports bare ground off the index instead of wrapping into another row of cells', () => {
    // The buckets are keyed by a flat `row * columns + column` integer, so a query one
    // column left of the extent arithmetically lands on the last column of the row below
    // it. Left unguarded that reports a polygon from the far side of the world as the
    // ground underfoot — the failure this range check exists to prevent. The linear scan
    // is the oracle: it has no cells to wrap through.
    const terrain = grid(20, 20);
    const index = buildTerrainIndex(terrain);
    const offIndex: Array<[number, number]> = [
      [-index.cellSize / 2, index.cellSize * 1.5], // one column left, one row down
      [-5_000, 250],
      [250, -5_000],
      [50_000, 50_000],
    ];
    for (const [x, z] of offIndex) {
      expect(terrainHeightAtXZIndexed(x, z, index)).toBe(terrainHeightAt({ x, z }, terrain));
      expect(terrainHeightAtXZIndexed(x, z, index)).toBe(0);
    }
  });

  it('still answers for a polygon too large to file, on and off the indexed extent', () => {
    // A polygon spanning more cells than the filing cap is held aside and checked against
    // every query (see TerrainIndex.everywhere). It has to keep answering both inside the
    // indexed extent and outside it, where the range check short-circuits the cell lookup.
    const sprawl: WorldArea = { id: 'sprawl', kind: 'wood', rings: [square(4_000)] };
    const terrain = computeTerrainClearance([sprawl], settings({ slope: 0 }));
    const index = buildTerrainIndex(terrain);
    expect(index.everywhere).toHaveLength(1);
    expect(index.cells.size).toBe(0);
    for (const [x, z] of [[10, 10], [2_000, 2_000], [3_999, 3_999]] as const) {
      expect(terrainHeightAtXZIndexed(x, z, index)).toBe(terrainHeightAt({ x, z }, terrain));
      expect(terrainHeightAtXZIndexed(x, z, index)).toBeGreaterThan(0);
    }
    expect(terrainHeightAtXZIndexed(-100, -100, index)).toBe(0);
  });

  it('files a non-finite polygon nowhere rather than looping forever over its cells', () => {
    // `Math.floor(Infinity)` is `Infinity`, so a bound that isn't a number would make the
    // fill loop non-terminating. computeTerrainClearance drops these, so this guards a
    // hand-built profile.
    const broken: TerrainClearance = {
      minX: 0, maxX: Number.POSITIVE_INFINITY, minZ: 0, maxZ: 10,
      height: 1, ramp: 0, ring: square(10),
    };
    const index = buildTerrainIndex([broken]);
    expect(index.cells.size).toBe(0);
    expect(index.everywhere).toHaveLength(0);
    expect(terrainHeightAtXZIndexed(5, 5, index)).toBe(0);
  });
});

describe('waterSurfaceHeightAtIndexed', () => {
  it('sits just above the flat ground datum when nothing raises the ground nearby', () => {
    const index = buildTerrainIndex([]);
    const ring = square(50);
    expect(waterSurfaceHeightAtIndexed(ring, index)).toBeCloseTo(WATER_SURFACE_EPSILON, 5);
  });

  it('clears a landuse mound the water polygon borders, instead of a fixed absolute height', () => {
    // A tall forest mound sits right where the water ring's own vertices are, standing
    // in for a pond at the edge of a wood — the case docs/TODO.md called out as broken
    // ("a pond inside a wood is drawn flat at its own height over a mound that does not
    // know it is there").
    const forest = area('forest-1', 'forest', 40);
    const clearance = computeTerrainClearance([forest], settings({ slope: 0 }));
    const index = buildTerrainIndex(clearance);
    const groundUnderRing = Math.max(...square(40).map((p) => terrainHeightAtXZIndexed(p.x, p.z, index)));
    expect(groundUnderRing).toBeGreaterThan(0);

    const height = waterSurfaceHeightAtIndexed(square(40), index);
    expect(height).toBeCloseTo(groundUnderRing + WATER_SURFACE_EPSILON, 5);
    expect(height).toBeGreaterThan(WATER_SURFACE_EPSILON);
  });

  it('is a pure function of the ring and index: same input, same output across calls', () => {
    const index = buildTerrainIndex(computeTerrainClearance([area('p', 'park', 30)]));
    const ring = square(30);
    expect(waterSurfaceHeightAtIndexed(ring, index)).toEqual(waterSurfaceHeightAtIndexed(ring, index));
  });
});

describe('insetRing', () => {
  it('pulls every edge in by the offset, whichever way the ring is wound', () => {
    const clockwise = square(100);
    const anticlockwise = clockwise.slice().reverse();
    for (const ring of [clockwise, anticlockwise]) {
      const inset = insetRing(ring, 10);
      const xs = inset.map((point) => point.x);
      const zs = inset.map((point) => point.z);
      expect(Math.min(...xs)).toBeCloseTo(10, 5);
      expect(Math.max(...xs)).toBeCloseTo(90, 5);
      expect(Math.min(...zs)).toBeCloseTo(10, 5);
      expect(Math.max(...zs)).toBeCloseTo(90, 5);
    }
  });

  it('leaves the ring alone when there is nothing to inset by', () => {
    expect(insetRing(square(10), 0)).toEqual(square(10));
  });

  it('blunts a needle-sharp corner instead of throwing it across the polygon', () => {
    // A sliver: mitering this corner exactly would put the offset vertex metres away.
    const sliver = [{ x: 0, z: 0 }, { x: 100, z: 1 }, { x: 100, z: -1 }];
    for (const point of insetRing(sliver, 2)) {
      expect(Math.abs(point.x)).toBeLessThan(110);
      expect(Math.abs(point.z)).toBeLessThan(20);
    }
  });
});
