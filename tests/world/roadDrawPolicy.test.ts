import { describe, expect, it } from 'vitest';
import {
  createRoadSliceBudget,
  isMinorRoadKind,
  MINOR_ROAD_PAINT_DISTANCE,
  ROAD_GEOMETRY_POINT_BUDGET,
  roadPaintDistance,
} from '../../src/world/roadDrawPolicy';
import { MAX_TERRAIN_DRAW_DISTANCE } from '../../src/world/threeWorld';
import { getRoadFamily } from '../../src/svartaksi/roadStyle';
import { RENDER_QUALITY, fogDensityFor } from '../../src/world/renderOptions';

const TERRAIN = MAX_TERRAIN_DRAW_DISTANCE;

describe('isMinorRoadKind', () => {
  it('treats the whole path family and service roads as minor', () => {
    // These are the classes the committed snapshot actually contains in bulk: `path`
    // alone is a majority of all road polyline points in it.
    expect(isMinorRoadKind('path')).toBe(true);
    expect(isMinorRoadKind('service')).toBe(true);
    expect(isMinorRoadKind('track')).toBe(true);
    expect(isMinorRoadKind('footway')).toBe(true);
    expect(isMinorRoadKind('cycleway')).toBe(true);
    expect(isMinorRoadKind('steps')).toBe(true);
    expect(isMinorRoadKind('pedestrian')).toBe(true);
  });

  it('keeps residential streets and everything above them major', () => {
    // `minor` is OpenMapTiles' residential/unclassified street and is what the tile data
    // actually uses — it carries the readable street grid, so it is never culled early
    // even though it is far more numerous than the arterials.
    expect(isMinorRoadKind('minor')).toBe(false);
    expect(isMinorRoadKind('residential')).toBe(false);
    expect(isMinorRoadKind('tertiary')).toBe(false);
    expect(isMinorRoadKind('secondary')).toBe(false);
    expect(isMinorRoadKind('primary')).toBe(false);
    expect(isMinorRoadKind('trunk')).toBe(false);
    expect(isMinorRoadKind('motorway')).toBe(false);
  });

  it('treats an unrecognised class as an ordinary street rather than culling it early', () => {
    // getRoadFamily falls unknown classes through to 'minor' (a street), not 'path', so
    // an unmapped OSM value is never culled harder than the street it most likely is.
    expect(isMinorRoadKind('some_unmapped_class')).toBe(false);
    expect(isMinorRoadKind('')).toBe(false);
  });

  it('stays in step with the road family taxonomy it delegates to', () => {
    // The guard against this module drifting back into its own duplicated class table:
    // every path-family kind is minor, and no major-family kind ever is.
    for (const kind of ['path', 'footway', 'pedestrian', 'cycleway', 'track', 'steps', 'bridleway', 'corridor']) {
      expect(getRoadFamily(kind)).toBe('path');
      expect(isMinorRoadKind(kind)).toBe(true);
    }
    for (const kind of ['motorway', 'trunk', 'primary', 'secondary']) {
      expect(getRoadFamily(kind)).toBe('major');
      expect(isMinorRoadKind(kind)).toBe(false);
    }
  });
});

describe('roadPaintDistance', () => {
  it('gives major roads the full terrain radius', () => {
    expect(roadPaintDistance('motorway', TERRAIN)).toBe(TERRAIN);
    expect(roadPaintDistance('minor', TERRAIN)).toBe(TERRAIN);
  });

  it('shortens minor roads to the fog-derived radius', () => {
    expect(roadPaintDistance('service', TERRAIN)).toBe(MINOR_ROAD_PAINT_DISTANCE);
    expect(roadPaintDistance('path', TERRAIN)).toBe(MINOR_ROAD_PAINT_DISTANCE);
  });

  it('never widens the cull when the terrain radius is smaller than the minor radius', () => {
    const narrow = MINOR_ROAD_PAINT_DISTANCE - 100;
    expect(roadPaintDistance('service', narrow)).toBe(narrow);
    expect(roadPaintDistance('motorway', narrow)).toBe(narrow);
  });
});

describe('MINOR_ROAD_PAINT_DISTANCE', () => {
  it('stays beyond every tier building distance, so props never outlive their road', () => {
    // Street lights, signals, bus stops and post boxes are placed against roads
    // re-filtered to `buildingDistance`. If the paint radius fell below the largest of
    // those, a lamp could stand on a road that was culled out from under it.
    const widest = Math.max(...Object.values(RENDER_QUALITY).map((tier) => tier.buildingDistance));
    expect(MINOR_ROAD_PAINT_DISTANCE).toBeGreaterThan(widest);
  });

  it('sits where the thinnest fog this project can produce is effectively opaque', () => {
    // The constant's stated derivation, asserted rather than trusted: the least foggy
    // configuration is the largest building distance, since the budget scale only pulls
    // it down. FogExp2 opacity is 1 - exp(-(d * density)^2).
    const widest = Math.max(...Object.values(RENDER_QUALITY).map((tier) => tier.buildingDistance));
    const thinnestDensity = fogDensityFor(widest);
    const opacityAt = (distance: number) => 1 - Math.exp(-((distance * thinnestDensity) ** 2));

    expect(opacityAt(MINOR_ROAD_PAINT_DISTANCE)).toBeGreaterThan(0.999);
    // And it is not needlessly far inside the fog either — at the radius the check above
    // guards, the world is still visibly not opaque, so the cull is not encroaching on
    // anything the player can actually see.
    expect(opacityAt(widest)).toBeLessThan(0.999);
  });
});

describe('createRoadSliceBudget', () => {
  it('does not yield until the point budget is spent', () => {
    const budget = createRoadSliceBudget(100);
    expect(budget.shouldYieldAfter(40)).toBe(false);
    expect(budget.shouldYieldAfter(40)).toBe(false);
    expect(budget.pending()).toBe(80);
    expect(budget.shouldYieldAfter(20)).toBe(true);
  });

  it('resets after a boundary so each slice starts with a full budget', () => {
    const budget = createRoadSliceBudget(100);
    expect(budget.shouldYieldAfter(100)).toBe(true);
    expect(budget.pending()).toBe(0);
    expect(budget.shouldYieldAfter(99)).toBe(false);
  });

  it('yields immediately on one road bigger than the whole budget', () => {
    // The overshoot case: a road is never split, so a 400-point ring road spends a
    // 100-point budget in one charge and the boundary falls right after it.
    const budget = createRoadSliceBudget(100);
    expect(budget.shouldYieldAfter(400)).toBe(true);
    expect(budget.pending()).toBe(0);
  });

  it('slices many short roads far less often than one long road', () => {
    // The whole point of counting points rather than roads: 8 two-point stubs and one
    // 300-point ring road are wildly different amounts of work, and a road-count cadence
    // cannot tell them apart.
    const shortRoads = createRoadSliceBudget(128);
    let shortYields = 0;
    for (let i = 0; i < 8; i += 1) if (shortRoads.shouldYieldAfter(2)) shortYields += 1;
    expect(shortYields).toBe(0);

    const longRoad = createRoadSliceBudget(128);
    expect(longRoad.shouldYieldAfter(300)).toBe(true);
  });

  it('treats a degenerate or negative point count as no work', () => {
    const budget = createRoadSliceBudget(10);
    expect(budget.shouldYieldAfter(0)).toBe(false);
    expect(budget.shouldYieldAfter(-5)).toBe(false);
    expect(budget.pending()).toBe(0);
  });

  it('defaults to the shared point budget', () => {
    const budget = createRoadSliceBudget();
    expect(budget.shouldYieldAfter(ROAD_GEOMETRY_POINT_BUDGET - 1)).toBe(false);
    expect(budget.shouldYieldAfter(1)).toBe(true);
  });
});
