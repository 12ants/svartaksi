import { describe, expect, it } from 'vitest';
import { buildTerrainIndex, terrainClearanceFor, WATER_SURFACE_EPSILON } from '../../src/world/terrain';
import {
  buildWaterIndex,
  emptyWaterIndex,
  WATER_OPEN_DEPTH,
  WATER_SHELF_WIDTH,
  waterDepthAtXZ,
  waterHeightAtXZ,
  waterSampleAtXZ,
} from '../../src/world/waterIndex';
import type { WorldArea } from '../../src/world/types';

function square(x: number, z: number, size: number) {
  return [
    { x, z },
    { x: x + size, z },
    { x: x + size, z: z + size },
    { x, z: z + size },
  ];
}

function water(id: string, rings: { x: number; z: number }[][]): WorldArea {
  return { id, kind: 'water', rings };
}

const flatTerrain = buildTerrainIndex([]);

describe('buildWaterIndex / waterHeightAtXZ', () => {
  it('reports a surface inside a water polygon and nothing outside it', () => {
    const index = buildWaterIndex([water('lake', [square(0, 0, 100)])], flatTerrain);
    expect(waterHeightAtXZ(50, 50, index)).toBeCloseTo(WATER_SURFACE_EPSILON, 6);
    // Shore-exit is exactly this: no polygon covers the point at all.
    expect(waterHeightAtXZ(-5, 50, index)).toBeNull();
    expect(waterHeightAtXZ(50, 140, index)).toBeNull();
  });

  it('reports the same height the renderer draws the sheet at, terrain and all', () => {
    // A water polygon bordering a raised wood takes its height from the tallest ground
    // under its own vertices — see waterSurfaceHeightAtIndexed. The index has to agree
    // with that, or the pill floats at a height the water is not drawn at.
    const terrain = buildTerrainIndex(terrainClearanceFor(
      true, [{ id: 'wood', kind: 'wood', rings: [square(-40, -40, 80)] }],
    ));
    const pond = water('pond', [square(0, 0, 60)]);
    const index = buildWaterIndex([pond], terrain);
    const height = waterHeightAtXZ(30, 30, index);
    expect(height).not.toBeNull();
    expect(height!).toBeGreaterThan(WATER_SURFACE_EPSILON);
  });

  it('treats an island as land, not as part of the lake around it', () => {
    const index = buildWaterIndex([water('lake', [square(0, 0, 100), square(40, 40, 20)])], flatTerrain);
    expect(waterHeightAtXZ(10, 10, index)).not.toBeNull();
    expect(waterHeightAtXZ(50, 50, index)).toBeNull();
  });

  it('answers with the higher sheet where two polygons overlap', () => {
    // A bay drawn over the sea it opens into is the common case; the one actually drawn
    // on top is the one a body floats on.
    const raised = buildTerrainIndex(terrainClearanceFor(
      true, [{ id: 'wood', kind: 'wood', rings: [square(-30, -30, 70)] }],
    ));
    const sea = water('sea', [square(-200, -200, 400)]);
    const bay = water('bay', [square(0, 0, 10)]);
    const index = buildWaterIndex([sea, bay], raised);
    const seaOnly = waterHeightAtXZ(-100, -100, index)!;
    expect(waterHeightAtXZ(5, 5, index)!).toBeGreaterThan(seaOnly);
  });

  it('ignores degenerate rings rather than filing them', () => {
    const index = buildWaterIndex([
      water('sliver', [[{ x: 0, z: 0 }, { x: 1, z: 0 }]]),
      water('empty', []),
    ], flatTerrain);
    expect(index.count).toBe(0);
    expect(waterHeightAtXZ(0.5, 0, index)).toBeNull();
  });

  it('answers null everywhere for the empty index a runtime starts on', () => {
    const index = emptyWaterIndex();
    expect(waterHeightAtXZ(0, 0, index)).toBeNull();
    expect(waterHeightAtXZ(9000, -9000, index)).toBeNull();
  });

  it('does not report water on the far side of the world for a query outside its extent', () => {
    // The grid keys cells by a flat row*columns+column integer, which only holds inside
    // the index's own extent — the trap spatialGrid.ts documents. A query far outside it
    // must not wrap onto a bucket that happens to hold the one lake there is.
    const index = buildWaterIndex([water('lake', [square(0, 0, 100)])], flatTerrain);
    for (let step = 1; step <= 40; step += 1) {
      expect(waterHeightAtXZ(-step * 64, step * 64, index)).toBeNull();
      expect(waterHeightAtXZ(step * 64, -step * 64, index)).toBeNull();
    }
  });
});

describe('the implied bed', () => {
  // Nothing in the source says how deep anything is, and the sheet is drawn 2cm over the
  // same flat ground everything else stands on — so depth is derived from the one thing
  // the data does state, which is where the water ends.
  const index = buildWaterIndex([water('lake', [square(0, 0, 200)])], flatTerrain);

  it('shelves from nothing at the shore to open depth a shelf-width in', () => {
    expect(waterDepthAtXZ(0.05, 100, index)!).toBeLessThan(0.05);
    expect(waterDepthAtXZ(WATER_SHELF_WIDTH / 2, 100, index)!).toBeCloseTo(WATER_OPEN_DEPTH / 2, 5);
    expect(waterDepthAtXZ(WATER_SHELF_WIDTH, 100, index)!).toBeCloseTo(WATER_OPEN_DEPTH, 5);
    expect(waterDepthAtXZ(100, 100, index)!).toBeCloseTo(WATER_OPEN_DEPTH, 5);
  });

  it('gets monotonically deeper the further out you wade, with no step anywhere', () => {
    let previous = -1;
    for (let metres = 0; metres <= WATER_SHELF_WIDTH; metres += 0.25) {
      const depth = waterDepthAtXZ(metres, 100, index)!;
      expect(depth).toBeGreaterThanOrEqual(previous);
      previous = depth;
    }
  });

  it('shelves off an island too, so swimming up to a holm shallows out rather than ending at a wall', () => {
    const holm = buildWaterIndex([water('lake', [square(0, 0, 200), square(90, 90, 20)])], flatTerrain);
    // Just outside the island's edge: shallow, even though it is 90m from the outer shore.
    expect(waterDepthAtXZ(89.5, 100, holm)!).toBeLessThan(WATER_OPEN_DEPTH / 2);
    expect(waterDepthAtXZ(80, 100, holm)!).toBeCloseTo(WATER_OPEN_DEPTH, 5);
  });

  it('reports the same surface either way, and nothing at all outside the water', () => {
    const sample = waterSampleAtXZ(100, 100, index)!;
    expect(sample.surface).toBe(waterHeightAtXZ(100, 100, index));
    expect(waterSampleAtXZ(-1, 100, index)).toBeNull();
    expect(waterDepthAtXZ(-1, 100, index)).toBeNull();
  });
});
