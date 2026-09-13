import { describe, expect, it } from 'vitest';

import {
  INTRO_ROAD_LENGTH,
  INTRO_ROAD_PATH,
  buildIntroStage,
} from '../../src/svartaksi/introStage';
import { BUS_DIMENSIONS } from '../../src/svartaksi/busGeometry';
import { buildRideProfile } from '../../src/svartaksi/busRouting';
import { generateTrees } from '../../src/world/vegetation';
import { pointInRing } from '../../src/world/geo';

/** Distance from a point to the nearest vertex of the centreline. Good enough for the
 * clearance assertions below, which are about metres of verge, not millimetres. */
function distanceToRoad(x: number, z: number): number {
  let nearest = Infinity;
  for (const point of INTRO_ROAD_PATH) {
    nearest = Math.min(nearest, Math.hypot(point.x - x, point.z - z));
  }
  return nearest;
}

describe('the synthesized intro stage', () => {
  it('is a WorldData the rest of the pipeline can consume unchanged', () => {
    const stage = buildIntroStage();
    expect(stage.source).toBe('maplibre');
    expect(stage.roads).toHaveLength(1);
    expect(stage.roads[0].points).toBe(INTRO_ROAD_PATH);
    // A road through a wood and nothing else: both empty lists are deliberate, not an
    // oversight, and a future change that starts adding buildings should have to say so.
    expect(stage.buildings).toEqual([]);
    expect(stage.water).toEqual([]);
    expect(stage.parks).toHaveLength(2);
  });

  it('samples the road finely enough that its bends read as bends', () => {
    let longest = 0;
    for (let i = 1; i < INTRO_ROAD_PATH.length; i += 1) {
      longest = Math.max(longest, Math.hypot(
        INTRO_ROAD_PATH[i].x - INTRO_ROAD_PATH[i - 1].x,
        INTRO_ROAD_PATH[i].z - INTRO_ROAD_PATH[i - 1].z,
      ));
    }
    // Coarser sampling makes buildRideProfile fit a tighter arc than the road really has
    // and slow the bus for a corner that is not there.
    expect(longest).toBeLessThan(5);
  });

  it('traces the length its segments declare', () => {
    const profile = buildRideProfile(INTRO_ROAD_PATH);
    expect(profile.length).toBeCloseTo(INTRO_ROAD_LENGTH, 0);
  });

  it('bends by enough to be worth filming, but never tighter than the bus can turn', () => {
    let sharpest = Infinity;
    let widest = 0;
    for (let i = 1; i < INTRO_ROAD_PATH.length - 1; i += 1) {
      const before = INTRO_ROAD_PATH[i - 1];
      const here = INTRO_ROAD_PATH[i];
      const after = INTRO_ROAD_PATH[i + 1];
      const headingIn = Math.atan2(here.x - before.x, here.z - before.z);
      const headingOut = Math.atan2(after.x - here.x, after.z - here.z);
      const turn = Math.abs(Math.atan2(
        Math.sin(headingOut - headingIn),
        Math.cos(headingOut - headingIn),
      ));
      if (turn < 1e-6) continue;
      const leg = Math.hypot(here.x - before.x, here.z - before.z);
      const radius = leg / turn;
      sharpest = Math.min(sharpest, radius);
      widest = Math.max(widest, turn);
    }
    // The authored weave radius, recovered from the polyline rather than restated.
    expect(sharpest).toBeGreaterThan(BUS_DIMENSIONS.minTurnRadius * 5);
    expect(sharpest).toBeLessThan(80);
    expect(widest).toBeGreaterThan(0);
  });

  it('returns to its original heading after the weave, and ends on a straight', () => {
    const last = INTRO_ROAD_PATH[INTRO_ROAD_PATH.length - 1];
    const previous = INTRO_ROAD_PATH[INTRO_ROAD_PATH.length - 2];
    const heading = Math.atan2(last.x - previous.x, last.z - previous.z);
    // Westbound: the direction the whole shot design depends on (see scene 1).
    expect(heading).toBeCloseTo(-Math.PI / 2, 3);
    expect(last.x).toBeLessThan(INTRO_ROAD_PATH[0].x);
  });

  it('holds the forest back off the carriageway on both sides', () => {
    const stage = buildIntroStage();
    for (const park of stage.parks) {
      const ring = park.rings[0];
      expect(ring.length).toBeGreaterThan(8);
      // Closed ring, which is what the terrain and tree scatterers expect.
      expect(ring[0].x).toBeCloseTo(ring[ring.length - 1].x, 6);
      expect(ring[0].z).toBeCloseTo(ring[ring.length - 1].z, 6);
    }
    // No part of either treeline encroaches on the road surface. Checked against the
    // centreline rather than the ribbon edge, so the margin includes the carriageway.
    for (const park of stage.parks) {
      for (const point of park.rings[0]) {
        expect(distanceToRoad(point.x, point.z)).toBeGreaterThan(BUS_DIMENSIONS.width);
      }
    }
  });

  it('puts the two forests on opposite sides of the road', () => {
    const [north, south] = buildIntroStage().parks;
    // The first vertex of each band is the verge point beside the road's start, so their
    // midpoint should land back on the centreline if they genuinely straddle it.
    const midX = (north.rings[0][0].x + south.rings[0][0].x) / 2;
    const midZ = (north.rings[0][0].z + south.rings[0][0].z) / 2;
    expect(distanceToRoad(midX, midZ)).toBeLessThan(0.5);
  });

  it('grows a real forest when the scatterer is pointed at it', () => {
    const stage = buildIntroStage();
    const trees = generateTrees(stage.parks, 4_000);
    // `forest` is the densest kind in vegetation.ts's SPECIES table; the point of the
    // assertion is that authoring polygons is genuinely all that was needed to get trees.
    expect(trees.length).toBeGreaterThan(500);
    // And they stand where the polygons are, not on the road.
    for (const tree of trees.slice(0, 200)) {
      expect(distanceToRoad(tree.x, tree.z)).toBeGreaterThan(BUS_DIMENSIONS.width);
    }
  });

  it('keeps the road itself clear of both forest polygons', () => {
    const stage = buildIntroStage();
    // Sample the centreline rather than its endpoints: a band that crossed the road at a
    // bend would still leave both ends outside.
    for (let i = 0; i < INTRO_ROAD_PATH.length; i += 5) {
      const point = INTRO_ROAD_PATH[i];
      for (const park of stage.parks) {
        expect(pointInRing(point, park.rings[0])).toBe(false);
      }
    }
  });
});
