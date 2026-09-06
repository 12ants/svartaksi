import { describe, expect, it } from 'vitest';

import {
  assignEntrancesToParents,
  glassPaneForDoor,
  projectPointToWall,
  selectBuildingDoors,
  selectParentDoors,
  snapDoorCenter,
  type DoorWallCandidate,
} from '../../src/svartaksi/doorPlacement';

function wall(overrides: Partial<DoorWallCandidate> = {}): DoorWallCandidate {
  return {
    startX: 0,
    startY: 0,
    endX: 10,
    endY: 0,
    width: 10,
    height: 12,
    minHeight: 0,
    sidePadding: 1.2,
    ...overrides,
  };
}

describe('projectPointToWall', () => {
  it('projects onto the unclipped segment and reports local wall distance', () => {
    expect(projectPointToWall({ x: 4, y: 1 }, wall())).toMatchObject({
      t: 0.4,
      localX: 4,
      distance: 1,
    });
  });

  it('rejects points beyond segment endpoints or farther than the tolerance', () => {
    expect(projectPointToWall({ x: -0.1, y: 0 }, wall())).toBeNull();
    expect(projectPointToWall({ x: 10.1, y: 0 }, wall())).toBeNull();
    expect(projectPointToWall({ x: 5, y: 2.01 }, wall(), 2)).toBeNull();
  });
});

describe('snapDoorCenter', () => {
  it('snaps a mapped center into the safe corner bounds', () => {
    expect(snapDoorCenter(0.2, 10, 1.2, 1.1)).toBeCloseTo(1.75);
    expect(snapDoorCenter(9.8, 10, 1.2, 1.1)).toBeCloseTo(8.25);
    expect(snapDoorCenter(5, 10, 1.2, 1.1)).toBe(5);
  });

  it('rejects a wall that cannot fit the complete opening', () => {
    expect(snapDoorCenter(1, 3, 1.2, 1.1)).toBeNull();
  });
});

describe('selectBuildingDoors', () => {
  it('selects the nearest parent-matched mapped entrance in Balanced', () => {
    const result = selectBuildingDoors({
      parentId: 'parent-a',
      detail: 'balanced',
      walls: [wall(), wall({ startY: 5, endY: 5 })],
      entrances: [
        { id: 'wrong-parent', x: 2, y: 0.1, parentId: 'parent-b' },
        { id: 'farther', x: 7, y: 1.5, parentId: 'parent-a' },
        { id: 'nearest', x: 4, y: 0.2, parentId: 'parent-a' },
      ],
    });

    expect(result.outcome).toBe('mapped');
    expect(result.doors).toEqual([
      expect.objectContaining({ wallIndex: 0, centerX: 4, source: 'mapped', entranceId: 'nearest' }),
    ]);
  });

  it('keeps mapped entrances on distinct walls in Rich', () => {
    const result = selectBuildingDoors({
      detail: 'rich',
      walls: [wall(), wall({ startY: 6, endY: 6 })],
      entrances: [
        { id: 'a', x: 2, y: 0.1 },
        { id: 'duplicate-wall', x: 7, y: 0.2 },
        { id: 'b', x: 6, y: 5.9 },
      ],
    });

    expect(result.doors.map(door => door.wallIndex)).toEqual([0, 1]);
    expect(result.doors.every(door => door.source === 'mapped')).toBe(true);
  });

  it('falls back deterministically to the longest eligible ground wall', () => {
    const result = selectBuildingDoors({
      detail: 'balanced',
      entrances: [],
      walls: [wall({ width: 8, endX: 8 }), wall({ width: 14, endX: 14 })],
    });

    expect(result.outcome).toBe('fallback');
    expect(result.doors).toEqual([
      expect.objectContaining({ wallIndex: 1, centerX: 7, source: 'fallback' }),
    ]);
  });

  it('never places doors on raised, short, or narrow walls', () => {
    const result = selectBuildingDoors({
      detail: 'balanced',
      entrances: [{ id: 'mapped', x: 4, y: 0.1 }],
      walls: [
        wall({ minHeight: 0.3 }),
        wall({ startY: 4, endY: 4, height: 2 }),
        wall({ startY: 8, endY: 8, width: 3, endX: 3 }),
      ],
    });

    expect(result.doors).toEqual([]);
    expect(result.outcome).toBe('invalid');
  });

  it('reports omitted when no mapped entrance exists and no wall is eligible', () => {
    const result = selectBuildingDoors({
      detail: 'balanced',
      entrances: [],
      walls: [wall({ minHeight: 2 })],
    });
    expect(result).toEqual({ doors: [], outcome: 'omitted' });
  });
});

describe('selectParentDoors', () => {
  it('chooses mapped and fallback walls across every part of one parent', () => {
    const mapped = selectParentDoors({
      detail: 'balanced',
      entrances: [{ id: 'mapped', x: 22, y: 0.1 }],
      parts: [
        { partId: 'short', walls: [wall({ width: 8, endX: 8 })] },
        { partId: 'long', walls: [wall({ startX: 20, endX: 34, width: 14 })] },
      ],
    });
    expect(mapped.doors).toEqual([
      expect.objectContaining({ partId: 'long', wallIndex: 0, source: 'mapped' }),
    ]);

    const fallback = selectParentDoors({
      detail: 'balanced',
      entrances: [],
      parts: [
        { partId: 'short', walls: [wall({ width: 8, endX: 8 })] },
        { partId: 'long', walls: [wall({ startX: 20, endX: 34, width: 14 })] },
      ],
    });
    expect(fallback.doors).toEqual([
      expect.objectContaining({ partId: 'long', wallIndex: 0, source: 'fallback' }),
    ]);
  });

  it('assigns unparented entrances to the globally nearest parent wall', () => {
    const assignments = assignEntrancesToParents(
      [
        { parentId: 'far', parts: [{ partId: 'far-part', walls: [wall()] }] },
        {
          parentId: 'near',
          parts: [{ partId: 'near-part', walls: [wall({ startY: 3, endY: 3 })] }],
        },
      ],
      [{ id: 'entrance', x: 5, y: 2.8 }],
    );

    expect(assignments.get('near')?.map(point => point.id)).toEqual(['entrance']);
    expect(assignments.has('far')).toBe(false);
  });

  it('ignores an ineligible nearer parent when assigning an unparented entrance', () => {
    const assignments = assignEntrancesToParents(
      [
        {
          parentId: 'raised',
          parts: [{ partId: 'raised-part', walls: [wall({ minHeight: 1 })] }],
        },
        {
          parentId: 'ground',
          parts: [{ partId: 'ground-part', walls: [wall({ startY: 1.5, endY: 1.5 })] }],
        },
      ],
      [{ id: 'entrance', x: 5, y: 0.1 }],
    );

    expect(assignments.get('ground')?.map(point => point.id)).toEqual(['entrance']);
    expect(assignments.has('raised')).toBe(false);
  });
});

describe('glassPaneForDoor', () => {
  const door = { width: 1.1, height: 2.2 };

  it('gives no glass past the presence threshold', () => {
    expect(glassPaneForDoor(0.45, door)).toBeUndefined();
    expect(glassPaneForDoor(0.99, door)).toBeUndefined();
  });

  it('picks a smaller pane low in the roll and a larger one high in the roll, always inside the door', () => {
    const small = glassPaneForDoor(0.01, door);
    const large = glassPaneForDoor(0.44, door);
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(large!.width).toBeGreaterThan(small!.width);
    expect(large!.height).toBeGreaterThan(small!.height);
    for (const pane of [small!, large!]) {
      expect(pane.width).toBeLessThan(door.width);
      expect(pane.bottom + pane.height).toBeLessThanOrEqual(door.height);
      expect(pane.bottom).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic for a given seed', () => {
    expect(glassPaneForDoor(0.2, door)).toEqual(glassPaneForDoor(0.2, door));
  });
});
