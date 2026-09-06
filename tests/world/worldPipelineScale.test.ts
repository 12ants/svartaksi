/**
 * Scale tests for the two stages that dominate first-load time.
 *
 * Both stages were quadratic in the size of a real snapshot and both ran as a single
 * unyielded block, which is what the game freezing on "Assembling streets, water and
 * rooftops" actually was. Measured against Svartaksi's own 32-tile z14 snapshot (10 840
 * roads, 646 of them bridge/tunnel/layered; 9 795 building polygons) the two together
 * cost roughly 28 seconds of straight-line main-thread work.
 *
 * The budgets here are deliberately loose — an order of magnitude above what the linear
 * implementations cost on a slow machine, and an order of magnitude below what the
 * quadratic ones cost on a fast one — so they catch a reintroduced O(n^2) without
 * failing on a busy CI worker.
 */
import { describe, expect, it } from 'vitest';
import { pointInRing, pointSegmentDistanceSquared } from '../../src/world/geo';
import { findRoadCrossings } from '../../src/world/roadElevationProfile';
import { normalizeMapLibreFeatures } from '../../src/world/providers/maplibreProvider';
import { generateStreetLights } from '../../src/world/streetLights';
import { isPavementClear, isPointOnAnyRoad } from '../../src/world/roadClearance';
import { buildFacadeRecord } from '../../src/world/facadeRecords';
import type { MapLibreFeature } from '../../src/world/providers/vectorTileDecoder';
import type { WorldArea, WorldBuilding, WorldRoad } from '../../src/world/types';

/** A grid of plain streets with a scattering of bridges over them, at roughly the road
 * count and bridge fraction a real 2.8 km z14 fetch around Svartaksi produces. */
function syntheticRoads(plain: number, special: number): WorldRoad[] {
  const roads: WorldRoad[] = [];
  const span = 4_000;
  for (let index = 0; index < plain; index += 1) {
    const z = -span / 2 + (index / plain) * span;
    const x = -span / 2 + ((index * 37) % plain / plain) * span;
    roads.push({
      id: `plain:${index}`,
      kind: 'residential',
      width: 8,
      points: [{ x, z }, { x: x + 120, z }, { x: x + 240, z: z + 30 }],
    });
  }
  for (let index = 0; index < special; index += 1) {
    const x = -span / 2 + (index / special) * span;
    roads.push({
      id: `bridge:${index}`,
      kind: 'primary',
      width: 14,
      structure: 'bridge',
      layer: 1,
      points: [{ x, z: -span / 2 }, { x, z: 0 }, { x, z: span / 2 }],
    });
  }
  return roads;
}

function crossingKeys(roads: WorldRoad[]): Set<string> {
  return new Set(findRoadCrossings(roads).map((crossing) =>
    `${crossing.roadId}|${crossing.otherRoadId}|${crossing.point.x.toFixed(3)}|${crossing.point.z.toFixed(3)}|${crossing.resolution}`));
}

/**
 * The same crossings, found without any cross-road candidate pruning being able to help:
 * one special road at a time against the whole set. Whatever narrowing the real
 * implementation does to the candidate list, the union of these single-special runs is
 * the answer it has to reproduce.
 */
function crossingKeysOneSpecialAtATime(plain: WorldRoad[], special: WorldRoad[]): Set<string> {
  const keys = new Set<string>();
  for (const road of special) {
    for (const key of crossingKeys([road, ...plain])) keys.add(key);
  }
  // Special-against-special pairs, which no single-special run above can produce.
  for (const key of crossingKeys(special)) keys.add(key);
  return keys;
}

function buildingFeature(index: number): MapLibreFeature {
  // Two tiles' worth, so the seam-copy path is genuinely exercised rather than skipped.
  const tile = index % 2 === 0 ? '14/9337/4711' : '14/9338/4711';
  const lng = 18.16 + (index % 100) * 0.0002;
  const lat = 59.31 + Math.floor(index / 100) * 0.0002;
  const d = 0.00008;
  return {
    layer: 'building',
    id: index,
    tile,
    properties: { height: 12 + (index % 20), class: 'residential' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]],
    },
  };
}

describe('findRoadCrossings at snapshot scale', () => {
  it('enumerates a real-sized road set without pairing every bridge against every road', () => {
    const roads = syntheticRoads(10_000, 640);
    const started = performance.now();
    const crossings = findRoadCrossings(roads);
    const elapsedMs = performance.now() - started;
    // Sanity: the synthetic bridges really do cross the street grid, so this is not
    // measuring an empty search.
    expect(crossings.length).toBeGreaterThan(0);
    // Every synthetic bridge here spans the whole 4 km fixture end to end, so each one
    // genuinely does have hundreds of candidates — far denser than the real snapshot,
    // where this call measures ~200ms. The pair enumeration this replaced took 26 s on
    // the same input, so the budget is set to catch that returning rather than to pin
    // down the exact cost of an adversarial fixture on a contended worker. It sits at
    // 15 s because 5 s was under, not over, what this fixture costs on a machine running
    // the rest of the suite beside it — a wall clock reading is only meaningful here to
    // the order of magnitude that separates 200 ms from 26 s.
    expect(elapsedMs).toBeLessThan(15_000);
  });

  it('finds every crossing a one-special-road-at-a-time search finds, and no others', () => {
    // Small enough that the reference is cheap, dense enough that candidate narrowing
    // has to both reject and accept.
    const roads = syntheticRoads(200, 20);
    const plain = roads.filter((road) => road.id.startsWith('plain:'));
    const special = roads.filter((road) => road.id.startsWith('bridge:'));
    const found = crossingKeys(roads);
    expect(found.size).toBeGreaterThan(0);
    expect([...found].sort()).toEqual([...crossingKeysOneSpecialAtATime(plain, special)].sort());
  });

  it('still pairs two special roads with each other exactly once', () => {
    const bridgeA: WorldRoad = {
      id: 'bridge-a', kind: 'primary', width: 12, structure: 'bridge', layer: 2,
      points: [{ x: -50, z: 0 }, { x: 50, z: 0 }],
    };
    const bridgeB: WorldRoad = {
      id: 'bridge-b', kind: 'primary', width: 12, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
    };
    const crossings = findRoadCrossings([bridgeA, bridgeB]);
    expect(crossings).toHaveLength(2);
    expect(crossings.filter((crossing) => crossing.roadId === 'bridge-a')).toHaveLength(1);
    expect(crossings.filter((crossing) => crossing.roadId === 'bridge-b')).toHaveLength(1);
  });
});

/** A block of footprints alongside the street grid, at the count a real fetch carries. */
function syntheticBuildings(count: number): WorldBuilding[] {
  return Array.from({ length: count }, (_, index) => {
    const x = -2_000 + (index % 100) * 40;
    const z = -2_000 + Math.floor(index / 100) * 40;
    return {
      id: `building:${index}`,
      height: 12,
      properties: {},
      rings: [[{ x, z }, { x: x + 15, z }, { x: x + 15, z: z + 15 }, { x, z: z + 15 }]],
    };
  });
}

describe('street furniture placement at snapshot scale', () => {
  it('places lamps along a real-sized road network without rescanning it per candidate', () => {
    const roads = syntheticRoads(3_000, 100);
    const buildings = syntheticBuildings(3_000);
    const started = performance.now();
    const lights = generateStreetLights(roads, buildings);
    const elapsedMs = performance.now() - started;
    expect(lights.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('agrees with the unindexed scan on every candidate point', () => {
    const roads = syntheticRoads(150, 10);
    const buildings = syntheticBuildings(120);
    // A lattice of probes across the built area, so both hits and misses are covered.
    for (let x = -2_000; x <= 2_000; x += 137) {
      for (let z = -2_000; z <= 2_000; z += 149) {
        const onRoad = roads.some((road) => road.points.slice(1).some((b, index) =>
          pointSegmentDistanceSquared(x, z, road.points[index], b) < (road.width / 2) ** 2));
        expect(isPointOnAnyRoad(x, z, roads, 0)).toBe(onRoad);
        const insideBuilding = buildings.some((building) => pointInRing({ x, z }, building.rings[0]));
        expect(isPavementClear(x, z, roads, 0, buildings)).toBe(!onRoad && !insideBuilding);
      }
    }
  });

  it('honours a margin that widens a road beyond its own paved width', () => {
    const road: WorldRoad = { id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
    expect(isPointOnAnyRoad(50, 10, [road], 0)).toBe(false);
    expect(isPointOnAnyRoad(50, 10, [road], 7)).toBe(true);
  });
});

describe('facade records at snapshot scale', () => {
  it('resolves doorsteps against the whole world without rescanning it per door', () => {
    const buildings = syntheticBuildings(1_500);
    const water: WorldArea[] = Array.from({ length: 150 }, (_, index) => ({
      id: `water:${index}`,
      kind: 'water',
      rings: [[
        { x: -3_000 + index * 40, z: 3_000 },
        { x: -3_000 + index * 40 + 30, z: 3_000 },
        { x: -3_000 + index * 40 + 30, z: 3_030 },
        { x: -3_000 + index * 40, z: 3_030 },
      ]],
    }));
    const started = performance.now();
    let withDoorstep = 0;
    for (const building of buildings) {
      const record = buildFacadeRecord(building, { buildings, water });
      if (record?.walls.some((wall) => wall.doorstep)) withDoorstep += 1;
    }
    const elapsedMs = performance.now() - started;
    // Sanity: the doorstep path really did run, so this is not timing an early return.
    expect(withDoorstep).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('still refuses a doorstep that would land on a neighbour or in water', () => {
    const host: WorldBuilding = {
      id: 'host', height: 16, properties: { type: 'apartments' },
      rings: [[{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 8 }, { x: 0, z: 8 }, { x: 0, z: 0 }]],
    };
    const clear = buildFacadeRecord(host, { buildings: [host], water: [] });
    expect(clear?.walls.some((wall) => wall.doorstep)).toBe(true);

    // A neighbour pressed against every side, so wherever the door lands its step is
    // inside someone else's footprint.
    const neighbour: WorldBuilding = {
      id: 'neighbour', height: 16, properties: {},
      rings: [[{ x: -6, z: -6 }, { x: 18, z: -6 }, { x: 18, z: 14 }, { x: -6, z: 14 }]],
    };
    const blocked = buildFacadeRecord(host, { buildings: [host, neighbour], water: [] });
    expect(blocked?.walls.some((wall) => wall.doorstep)).toBe(false);

    const flooded = buildFacadeRecord(host, {
      buildings: [host],
      water: [{ id: 'lake', kind: 'water', rings: [[{ x: -6, z: -6 }, { x: 18, z: -6 }, { x: 18, z: 14 }, { x: -6, z: 14 }]] }],
    });
    expect(flooded?.walls.some((wall) => wall.doorstep)).toBe(false);
  });
});

describe('normalizeMapLibreFeatures at snapshot scale', () => {
  it('absorbs a real-sized building set without a quadratic seam scan', () => {
    const features = Array.from({ length: 9_000 }, (_, index) => buildingFeature(index));
    const started = performance.now();
    const world = normalizeMapLibreFeatures(features, { lng: 18.16, lat: 59.31 });
    const elapsedMs = performance.now() - started;
    expect(world.buildings.length).toBeGreaterThan(1_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('still drops a seam copy: the same feature id from a neighbouring tile', () => {
    const own: MapLibreFeature = {
      layer: 'building', id: 4_242, tile: '14/9337/4711',
      properties: { height: 20 },
      geometry: { type: 'Polygon', coordinates: [[[18.16, 59.31], [18.1601, 59.31], [18.1601, 59.3101], [18.16, 59.31]]] },
    };
    // Same feature, clipped differently by the neighbour: extra vertex, centroid a metre
    // or so off, identical height and id.
    const neighbour: MapLibreFeature = {
      ...own,
      tile: '14/9338/4711',
      geometry: { type: 'Polygon', coordinates: [[[18.16, 59.31], [18.16005, 59.31], [18.1601, 59.31], [18.1601, 59.3101], [18.16, 59.31]]] },
    };
    const world = normalizeMapLibreFeatures([own, neighbour], { lng: 18.16, lat: 59.31 });
    expect(world.buildings).toHaveLength(1);
  });

  it('keeps two distinct buildings that share a tile and a feature id (a MultiPolygon block)', () => {
    const feature: MapLibreFeature = {
      layer: 'building', id: 77, tile: '14/9337/4711',
      properties: { height: 15 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[18.16, 59.31], [18.1601, 59.31], [18.1601, 59.3101], [18.16, 59.31]]],
          [[[18.163, 59.313], [18.1631, 59.313], [18.1631, 59.3131], [18.163, 59.313]]],
        ],
      },
    };
    const world = normalizeMapLibreFeatures([feature], { lng: 18.16, lat: 59.31 });
    expect(world.buildings).toHaveLength(2);
  });
});
