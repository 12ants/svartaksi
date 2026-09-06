/**
 * The four placement stages that used to run whole between two of the world builder's
 * yields — the reason build slices overran the frame budget by up to eleven times.
 *
 * Each now has an incremental `*Job` form that the builder drives with `yield*`, and an
 * eager form that drains it. These tests hold the two properties the change rests on:
 * pausing the walk does not change what it produces, and the walk really does pause.
 */
import { describe, expect, it } from 'vitest';
import { generateStreetLights, generateStreetLightsJob } from '@/world/streetLights';
import { generateTrees, generateTreesJob } from '@/world/vegetation';
import { findTrafficSignals, findTrafficSignalsJob } from '@/svartaksi/trafficLights';
import { generateNeonSigns, generateNeonSignsJob } from '@/svartaksi/neonSigns';
import type { WorldArea, WorldBuilding, WorldObject, WorldRoad } from '@/world/types';

/** A straight road of `length` metres, offset onto its own line so a grid of them meets. */
function road(id: string, x: number, z: number, kind = 'residential', width = 7): WorldRoad {
  return {
    id,
    kind,
    width,
    points: [{ x, z }, { x: x + 600, z }],
  } as WorldRoad;
}

function crossRoad(id: string, x: number, kind = 'primary', width = 12): WorldRoad {
  return {
    id,
    kind,
    width,
    points: [{ x, z: -400 }, { x, z: 400 }],
  } as WorldRoad;
}

function square(id: string, x: number, z: number, size: number): WorldBuilding {
  return {
    id,
    height: 18,
    properties: {},
    rings: [[
      { x, z }, { x: x + size, z }, { x: x + size, z: z + size }, { x, z: z + size }, { x, z },
    ]],
  } as WorldBuilding;
}

/** Runs a job to completion, counting how many times it handed the frame back. */
function drain<T>(job: Generator<void, T, void>): { value: T; yields: number } {
  let yields = 0;
  let step = job.next();
  while (!step.done) {
    yields += 1;
    step = job.next();
  }
  return { value: step.value, yields };
}

describe('street lamps', () => {
  const roads = Array.from({ length: 900 }, (_, index) => road(`r${index}`, 0, index * 30));
  const buildings = Array.from({ length: 40 }, (_, index) => square(`b${index}`, index * 40, 12, 20));

  it('places exactly the same lamps whether or not it pauses', () => {
    const { value } = drain(generateStreetLightsJob(roads, buildings));

    expect(value).toEqual(generateStreetLights(roads, buildings));
    expect(value.length).toBeGreaterThan(0);
  });

  it('actually hands the frame back, rather than yielding once at the end', () => {
    const { yields } = drain(generateStreetLightsJob(roads, buildings));

    expect(yields).toBeGreaterThan(1);
  });

  it('keeps the emitted order, since the caller keeps only the first N it can afford', () => {
    const { value } = drain(generateStreetLightsJob(roads, buildings));

    expect(value.slice(0, 20)).toEqual(generateStreetLights(roads, buildings).slice(0, 20));
  });
});

describe('scattered trees', () => {
  const areas: WorldArea[] = Array.from({ length: 60 }, (_, index) => ({
    id: `forest-${index}`,
    kind: 'forest',
    rings: [[
      { x: index * 300, z: 0 },
      { x: index * 300 + 200, z: 0 },
      { x: index * 300 + 200, z: 200 },
      { x: index * 300, z: 200 },
      { x: index * 300, z: 0 },
    ]],
  } as WorldArea));

  it('scatters identically whether or not it pauses', () => {
    const { value, yields } = drain(generateTreesJob(areas, 5_000));

    expect(value).toEqual(generateTrees(areas, 5_000));
    expect(value.length).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(1);
  });

  it('respects the same limit either way', () => {
    const { value } = drain(generateTreesJob(areas, 25));

    expect(value).toHaveLength(25);
    expect(value).toEqual(generateTrees(areas, 25));
  });
});

describe('traffic signals', () => {
  const roads = [
    ...Array.from({ length: 300 }, (_, index) => road(`main-${index}`, -300, index * 60, 'primary', 14)),
    ...Array.from({ length: 300 }, (_, index) => crossRoad(`cross-${index}`, index * 60, 'primary', 14)),
  ];

  it('signals the same junctions whether or not it pauses', () => {
    const { value, yields } = drain(findTrafficSignalsJob(roads, 200));

    expect(value).toEqual(findTrafficSignals(roads, 200));
    expect(value.length).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(1);
  });

  it('still answers an empty budget with nothing', () => {
    expect(drain(findTrafficSignalsJob(roads, 0)).value).toEqual([]);
  });
});

describe('neon signs', () => {
  const buildings = Array.from({ length: 600 }, (_, index) => square(`b${index}`, index * 30, 0, 18));
  const objects: WorldObject[] = Array.from({ length: 600 }, (_, index) => ({
    id: `shop-${index}`,
    kind: 'storefront',
    point: { x: index * 30 + 9, z: -3 },
  } as WorldObject));

  it('hangs the same signs whether or not it pauses', () => {
    const { value, yields } = drain(generateNeonSignsJob(objects, buildings, 400));

    expect(value).toEqual(generateNeonSigns(objects, buildings, 400));
    expect(value.length).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(1);
  });

  it('still gives one building at most one sign when it is paused mid-walk', () => {
    const { value } = drain(generateNeonSignsJob(objects, buildings, 400));
    const positions = value.map((sign) => `${sign.x.toFixed(3)}:${sign.z.toFixed(3)}`);

    expect(new Set(positions).size).toBe(positions.length);
  });
});
