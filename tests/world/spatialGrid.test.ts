import { describe, expect, it } from 'vitest';
import { boundsOfPoints, createSpatialGrid, memoizedSpatialGrid, type Bounds } from '../../src/world/spatialGrid';

/** A named box, so a failing assertion says which item leaked through rather than which
 * anonymous object literal did. */
interface Item {
  id: string;
  box: Bounds;
}

const item = (id: string, minX: number, minZ: number, maxX: number, maxZ: number): Item =>
  ({ id, box: { minX, minZ, maxX, maxZ } });

const boxOf = (candidate: Item) => candidate.box;

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;

/** Every item the query box actually touches — the answer a grid is only ever allowed to
 * over-approximate, never to miss. */
const trueHits = (items: Item[], query: Bounds): string[] =>
  items.filter((candidate) => overlaps(candidate.box, query)).map((candidate) => candidate.id).sort();

const visited = (items: Item[], query: Bounds, cellMeters: number, maxCellsPerItem?: number): string[] => {
  const grid = createSpatialGrid(items, boxOf, { cellMeters, maxCellsPerItem });
  const seen = new Set<string>();
  grid.forEachNear(query, (candidate) => seen.add(candidate.id));
  return [...seen].sort();
};

describe('boundsOfPoints', () => {
  it('bounds a ring, and refuses one it cannot bound', () => {
    expect(boundsOfPoints([{ x: 1, z: 4 }, { x: -3, z: 2 }, { x: 0, z: 9 }]))
      .toEqual({ minX: -3, maxX: 1, minZ: 2, maxZ: 9 });
    expect(boundsOfPoints([])).toBeNull();
    expect(boundsOfPoints([{ x: Number.NaN, z: 0 }])).toBeNull();
  });
});

describe('createSpatialGrid', () => {
  it('visits every item a query box really touches', () => {
    const items = [item('a', 0, 0, 5, 5), item('b', 100, 100, 105, 105), item('c', 45, 45, 55, 55)];
    const query = { minX: 40, maxX: 60, minZ: 40, maxZ: 60 };
    expect(visited(items, query, 20)).toEqual(trueHits(items, query));
  });

  it('never misses an item, at any cell size, over a spread of query boxes', () => {
    // The grid is allowed to hand back a candidate the caller then rejects; it is never
    // allowed to drop one. Cell size is the knob most likely to break that, so sweep it.
    const items: Item[] = [];
    for (let index = 0; index < 60; index += 1) {
      const x = (index % 10) * 37 - 150;
      const z = Math.floor(index / 10) * 41 - 120;
      items.push(item(`i-${index}`, x, z, x + 12, z + 9));
    }
    const queries: Bounds[] = [
      { minX: -200, maxX: -190, minZ: -200, maxZ: -190 },
      { minX: -160, maxX: -140, minZ: -130, maxZ: -110 },
      { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      { minX: 100, maxX: 260, minZ: -130, maxZ: 60 },
      { minX: 1_000, maxX: 1_100, minZ: 1_000, maxZ: 1_100 },
    ];
    for (const cellMeters of [5, 17, 40, 200]) {
      for (const query of queries) {
        const seen = visited(items, query, cellMeters);
        for (const id of trueHits(items, query)) expect(seen).toContain(id);
      }
    }
  });

  it('does not wrap an out-of-extent query into another row of cells', () => {
    // Buckets are keyed `row * columns + column`. A query one column left of the extent
    // arithmetically lands on the last column of the row below it, so without a range
    // check `anyNear` reports a hit against an item nowhere near the query — which for
    // the placement callers (roadClearance, doorstep) means refusing to plant a lamp
    // because of a road on the far side of the world.
    const items = [item('origin', 0, 0, 5, 5), item('far-east', 40, 0, 45, 5)];
    // cellMeters 10 puts `far-east` in column 4 of row 0; the query below asks for column
    // -1 of row 1, which shares that key.
    const query = { minX: -10, maxX: -6, minZ: 10, maxZ: 14 };
    expect(trueHits(items, query)).toEqual([]);
    expect(visited(items, query, 10)).toEqual([]);
  });

  it('checks an item too large to file against every query, in and out of the extent', () => {
    const sprawling = item('sprawl', -500, -500, 500, 500);
    const items = [item('small', 0, 0, 5, 5), sprawling];
    // A cap of 4 cells forces `sprawl` onto the unfileable list.
    expect(visited(items, { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, 10, 4)).toEqual(['small', 'sprawl']);
    expect(visited(items, { minX: -400, maxX: -399, minZ: -400, maxZ: -399 }, 10, 4)).toEqual(['sprawl']);
  });

  it('short-circuits anyNear at the first accepted item', () => {
    const items = [item('a', 0, 0, 5, 5), item('b', 1, 1, 6, 6), item('c', 2, 2, 7, 7)];
    const grid = createSpatialGrid(items, boxOf, { cellMeters: 50 });
    let examined = 0;
    expect(grid.anyNear({ minX: 0, maxX: 7, minZ: 0, maxZ: 7 }, () => {
      examined += 1;
      return true;
    })).toBe(true);
    expect(examined).toBe(1);
  });

  it('answers an empty set, and a set nothing can be bounded from, without a hit', () => {
    expect(visited([], { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, 10)).toEqual([]);
    const grid = createSpatialGrid([{ id: 'x' }], () => null, { cellMeters: 10 });
    expect(grid.anyNear({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, () => true)).toBe(false);
  });
});

describe('memoizedSpatialGrid', () => {
  it('builds one grid per source array and reuses it', () => {
    let built = 0;
    const gridFor = memoizedSpatialGrid<Item[], Item>(
      (items) => {
        built += 1;
        return items;
      },
      boxOf,
      { cellMeters: 20 },
    );
    const source = [item('a', 0, 0, 5, 5)];
    expect(gridFor(source)).toBe(gridFor(source));
    expect(built).toBe(1);

    gridFor([item('b', 0, 0, 5, 5)]);
    expect(built).toBe(2);
  });
});
