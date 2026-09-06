import { describe, expect, it } from 'vitest';

import { resolveDoorstep } from '../../src/svartaksi/doorstep';
import { buildFacadeRecord } from '../../src/world/facadeRecords';
import type { WorldArea, WorldBuilding } from '../../src/world/types';

const building: WorldBuilding = {
  id: 'home',
  height: 12,
  properties: { building: 'house' },
  rings: [[
    { x: 0, z: 0 },
    { x: 12, z: 0 },
    { x: 12, z: 8 },
    { x: 0, z: 8 },
  ]],
};

function entrance() {
  const record = buildFacadeRecord(building);
  const wall = record?.walls.find(candidate => candidate.door);
  if (!wall?.door) throw new Error('Expected facade door');
  return { wall, door: wall.door };
}

/** A small axis-aligned ring straddling the ground just outside the entrance wall —
 * built from the wall's own outward normal so these cases keep testing "something is in
 * the way of the step" rather than "the door happens to be on the z=0 wall". */
function obstacleOutsideEntrance(halfWidth: number, reach: number) {
  const { wall } = entrance();
  const alongX = Math.cos(wall.yaw);
  const alongZ = Math.sin(wall.yaw);
  const near = 0.1;
  return [
    { x: wall.centerX - alongX * halfWidth + wall.outwardX * near, z: wall.centerZ - alongZ * halfWidth + wall.outwardZ * near },
    { x: wall.centerX + alongX * halfWidth + wall.outwardX * near, z: wall.centerZ + alongZ * halfWidth + wall.outwardZ * near },
    { x: wall.centerX + alongX * halfWidth + wall.outwardX * reach, z: wall.centerZ + alongZ * halfWidth + wall.outwardZ * reach },
    { x: wall.centerX - alongX * halfWidth + wall.outwardX * reach, z: wall.centerZ - alongZ * halfWidth + wall.outwardZ * reach },
  ];
}

describe('resolveDoorstep', () => {
  it('creates a bounded residential step outside the entrance wall', () => {
    const { wall, door } = entrance();
    const result = resolveDoorstep({ wall, door, building, allBuildings: [building], water: [] });

    expect(result).toMatchObject({ kind: 'step', yaw: wall.yaw });
    // Centered on the wall, and displaced along its outward normal — never into the
    // building. Asserted through the normal rather than a fixed axis so the case does
    // not silently depend on which footprint edge the door lands on.
    const outwardOffset = (result!.center.x - wall.centerX) * wall.outwardX
      + (result!.center.z - wall.centerZ) * wall.outwardZ;
    const alongOffset = (result!.center.x - wall.centerX) * Math.cos(wall.yaw)
      + (result!.center.z - wall.centerZ) * Math.sin(wall.yaw);
    expect(outwardOffset).toBeGreaterThan(0);
    expect(alongOffset).toBeCloseTo(0);
    expect(result?.depth).toBeLessThanOrEqual(0.9);
    expect(result?.width).toBeLessThanOrEqual(door.width + 0.8);
    expect(result?.height).toBe(0.16);
  });

  it('rejects a footprint that overlaps water', () => {
    const { wall, door } = entrance();
    const water: WorldArea[] = [{
      id: 'water',
      kind: 'water',
      rings: [obstacleOutsideEntrance(2, 2)],
    }];

    expect(resolveDoorstep({ wall, door, building, allBuildings: [building], water })).toBeNull();
  });

  it('rejects a footprint that overlaps a neighboring building', () => {
    const { wall, door } = entrance();
    const neighbor: WorldBuilding = {
      ...building,
      id: 'neighbor',
      rings: [obstacleOutsideEntrance(1, 2)],
    };

    expect(resolveDoorstep({
      wall,
      door,
      building,
      allBuildings: [building, neighbor],
      water: [],
    })).toBeNull();
  });

  it('rejects a door on a wall without enough adjacent width', () => {
    const { wall, door } = entrance();
    expect(resolveDoorstep({
      wall: { ...wall, width: door.width + 0.2 },
      door,
      building,
      allBuildings: [building],
      water: [],
    })).toBeNull();
  });

  it('is deterministic and uses flat hardstanding for service buildings', () => {
    const { wall, door } = entrance();
    const industrial = {
      ...building,
      properties: { building: 'warehouse', 'building:use': 'industrial' },
    };
    const input = { wall, door, building: industrial, allBuildings: [industrial], water: [] };

    expect(resolveDoorstep(input)).toEqual(resolveDoorstep(input));
    expect(resolveDoorstep(input)).toMatchObject({ kind: 'hardstanding', height: 0.08 });
  });
});
