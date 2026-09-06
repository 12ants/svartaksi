import { describe, expect, it } from 'vitest';

import { buildFacadeRecord } from '../../src/world/facadeRecords';
import { DEFAULT_DOOR_BOTTOM, DEFAULT_DOOR_HEIGHT } from '../../src/svartaksi/doorPlacement';
import type { WorldBuilding } from '../../src/world/types';

const rectangle: WorldBuilding = {
  id: 'building-a',
  height: 16,
  properties: { type: 'apartments' },
  rings: [[
    { x: 0, z: 0 },
    { x: 12, z: 0 },
    { x: 12, z: 8 },
    { x: 0, z: 8 },
    { x: 0, z: 0 },
  ]],
};

describe('buildFacadeRecord', () => {
  it('derives outward, finite walls with centered window grids and one fallback door', () => {
    const record = buildFacadeRecord(rectangle);

    expect(record?.walls).toHaveLength(4);
    // Walls follow the canonical footprint winding (see orientFootprint), so this
    // counter-clockwise ring is walked in reverse from its own vertex order: the x=0
    // edge first, not the z=0 edge.
    expect(record?.walls.map(wall => wall.width)).toEqual([8, 12, 8, 12]);
    expect(record?.walls.filter(wall => wall.door)).toHaveLength(1);
    expect(record?.walls.find(wall => wall.door)?.door?.source).toBe('fallback');
    expect(record).toMatchObject({ id: 'building-a', centerX: 6, centerZ: 4, doorOutcome: 'fallback' });
    expect(record?.walls.map(wall => [wall.outwardX, wall.outwardZ])).toEqual([
      [-1, 0],
      [0, 1],
      [1, 0],
      [0, -1],
    ]);
    expect(record?.walls[0]).toMatchObject({ centerX: 0, centerY: 8, centerZ: 4 });

    for (const wall of record?.walls ?? []) {
      expect([
        wall.centerX,
        wall.centerY,
        wall.centerZ,
        wall.width,
        wall.height,
        wall.yaw,
        wall.outwardX,
        wall.outwardZ,
        wall.seed,
      ].every(Number.isFinite)).toBe(true);
      expect(wall.layout.startX).toBeCloseTo(wall.width - wall.layout.endX);
      expect(wall.layout.startY - wall.profile.firstFloorHeight).toBeCloseTo(
        wall.height - wall.profile.roofPadding - wall.layout.endY,
      );
    }
  });

  it('is deterministic and treats equivalent open and closed rings identically', () => {
    const closed = buildFacadeRecord(rectangle);
    const open = buildFacadeRecord({
      ...rectangle,
      rings: [rectangle.rings[0].slice(0, -1)],
    });

    expect(buildFacadeRecord(rectangle)).toEqual(closed);
    expect(open).toEqual(closed);
  });

  it('uses polygon area rather than vertex density for the footprint centroid', () => {
    const record = buildFacadeRecord({
      ...rectangle,
      rings: [[
        { x: 0, z: 0 },
        { x: 12, z: 0 },
        { x: 12, z: 8 },
        { x: 8, z: 8 },
        { x: 4, z: 8 },
        { x: 0, z: 8 },
      ]],
    });

    expect(record).toMatchObject({ centerX: 6, centerZ: 4 });
  });

  it('uses normalized building height for the office fallback', () => {
    const record = buildFacadeRecord({ ...rectangle, height: 64, properties: {} });

    expect(record?.walls[0].profile).toMatchObject({
      firstFloorHeight: 5,
      windowColor: expect.any(String),
    });
    expect(record?.walls[0].profileKey).toMatch(/^office:/);
  });

  it('derives facade family and mapped color from building properties', () => {
    const industrial = buildFacadeRecord({
      ...rectangle,
      properties: {
        building: 'warehouse',
        'building:use': 'industrial',
        'building:material': 'brick',
        'building:colour': '#a05a44',
      },
    });

    expect(industrial?.walls[0].profileKey).toMatch(/^industrial:/);
    expect(industrial?.walls[0].profile).toMatchObject({
      wallColor: '#A05A44',
      firstFloorHeight: 6,
      litRatio: 0.2,
    });
    expect(industrial?.walls.find(wall => wall.door)?.door?.style.kind).toBe('service');
  });

  it('gives a tagged shop the store family, a wide bright shopfront, and a family field matching its profile key', () => {
    const shop = buildFacadeRecord({ ...rectangle, properties: { shop: 'bakery' } });

    expect(shop?.walls[0].family).toBe('store');
    expect(shop?.walls[0].profileKey).toMatch(/^store:/);
    const residentialWindowWidth = buildFacadeRecord(rectangle)?.walls[0].profile.windowWidth ?? 0;
    expect(shop?.walls[0].profile.windowWidth).toBeGreaterThan(residentialWindowWidth);
    expect(shop?.walls[0].profile.litRatio).toBeGreaterThan(0.9);
    expect(shop?.walls[0].profile.windowGlow).toBeGreaterThan(0.8);
    expect(shop?.walls.find(wall => wall.door)?.door?.style.kind).toBe('shopfront');
    // Same clearance guarantee as the low-rise residential override — a store's own
    // wide ground-floor glass must not overlap its door either.
    expect(shop?.walls[0].profile.firstFloorHeight).toBeGreaterThanOrEqual(
      DEFAULT_DOOR_BOTTOM + DEFAULT_DOOR_HEIGHT,
    );
  });

  it('carries mapped entrance tags into deterministic door styling', () => {
    const record = buildFacadeRecord({
      ...rectangle,
      entrances: [{
        point: { x: 6, z: 0 },
        tags: { door: 'double', 'addr:housenumber': '12' },
      }],
    });

    expect(record?.doorOutcome).toBe('mapped');
    expect(record?.walls.find(wall => wall.door)?.door?.style.kind).toBe('double');
  });

  it('attaches a fitted doorstep when world collision context permits it', () => {
    const record = buildFacadeRecord(rectangle, {
      buildings: [rectangle],
      water: [],
    });

    expect(record?.walls.find(wall => wall.door)?.doorstep).toMatchObject({
      kind: 'step',
      height: 0.16,
    });
  });

  it('starts window grids low enough for small houses to actually have ground-floor windows', () => {
    const lowRise = buildFacadeRecord({ ...rectangle, height: 12 });
    // Shorter than the standard 4.0m ground floor used for taller residential
    // buildings, specifically so a small house's window row can start near the
    // ground — this can put row 0 at door height (the fragment shader is what
    // guarantees no window cell overlaps the door itself; see buildingFacade.ts).
    expect(lowRise?.walls[0].profile.firstFloorHeight).toBeCloseTo(1.05);
    expect(lowRise?.walls[0].profile.firstFloorHeight).toBeLessThan(4.0);
    expect(lowRise?.walls[0].layout.startY).toBeLessThan(3);
    for (const wall of lowRise?.walls ?? []) {
      expect(wall.layout.columns).toBeGreaterThan(0);
      expect(wall.layout.rows).toBeGreaterThan(0);
    }
  });

  it('derives outward normals from either ring winding', () => {
    const counterClockwise = buildFacadeRecord(rectangle);
    const clockwise = buildFacadeRecord({
      ...rectangle,
      rings: [[...rectangle.rings[0].slice(0, -1)].reverse()],
    });

    expect(counterClockwise?.walls.map(wall => [wall.outwardX, wall.outwardZ])).toEqual([
      [-1, 0], [0, 1], [1, 0], [0, -1],
    ]);
    expect(clockwise?.walls.map(wall => [wall.outwardX, wall.outwardZ])).toEqual([
      [0, 1], [1, 0], [0, -1], [-1, 0],
    ]);
  });

  it('walks every footprint in one rotational direction, whichever way the source ring wound', () => {
    // The renderer builds each wall's instance matrix as (edge direction, up, outward).
    // That basis is right-handed for one winding and mirrored for the other, and an
    // InstancedMesh cannot correct a mirrored instance — mixed windings would leave half
    // the city's walls, doorsteps and awnings drawn inside-out the moment facades stop
    // rendering DoubleSide.
    const rings = [
      rectangle.rings[0],
      [...rectangle.rings[0].slice(0, -1)].reverse(),
      [{ x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 18 }, { x: 15, z: 18 },
        { x: 15, z: 6 }, { x: 9, z: 6 }, { x: 9, z: 18 }, { x: 0, z: 18 }],
    ];

    for (const ring of rings) {
      const record = buildFacadeRecord({ ...rectangle, rings: [ring] });
      for (const wall of record?.walls ?? []) {
        // det[(cos yaw, 0, sin yaw), (0, 1, 0), (outwardX, 0, outwardZ)] > 0
        const determinant = Math.cos(wall.yaw) * wall.outwardZ - Math.sin(wall.yaw) * wall.outwardX;
        expect(determinant).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every concave-ring wall offset on its local outward side', () => {
    const record = buildFacadeRecord({
      ...rectangle,
      rings: [[
        { x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 18 },
        { x: 15, z: 18 }, { x: 15, z: 6 }, { x: 9, z: 6 },
        { x: 9, z: 18 }, { x: 0, z: 18 },
      ]],
    });

    expect(record?.walls.map(wall => [wall.outwardX, wall.outwardZ])).toEqual([
      [-1, 0], [0, 1], [1, 0], [0, 1], [-1, 0],
      [0, 1], [1, 0], [0, -1],
    ]);
  });

  it('rejects non-finite points and zero-length edges', () => {
    expect(buildFacadeRecord({
      ...rectangle,
      rings: [[{ x: 0, z: 0 }, { x: Number.NaN, z: 0 }, { x: 0, z: 8 }]],
    })).toBeNull();
    expect(buildFacadeRecord({
      ...rectangle,
      rings: [[{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 0 }, { x: 0, z: 8 }]],
    })).toBeNull();
  });

  it('rejects a zero-area footprint without emitting non-finite centroid values', () => {
    expect(buildFacadeRecord({
      ...rectangle,
      rings: [[{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 24, z: 0 }]],
    })).toBeNull();
  });

  it('gives small buildings plain facades when no complete window grid fits', () => {
    const record = buildFacadeRecord({
      ...rectangle,
      height: 5,
      rings: [[{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }]],
    });
    expect(record?.walls).toHaveLength(4);
    expect(record?.walls.every(wall => wall.layout.columns === 0 && wall.layout.rows === 0)).toBe(true);
  });
});
