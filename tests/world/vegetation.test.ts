import { describe, expect, it } from 'vitest';

import { generateTrees, mappedTrees, pointInRing } from '../../src/world/vegetation';
import type { WorldArea, WorldObject } from '../../src/world/types';

function square(id: string, kind: string, half: number): WorldArea {
  return {
    id,
    kind,
    rings: [[
      { x: -half, z: -half },
      { x: half, z: -half },
      { x: half, z: half },
      { x: -half, z: half },
    ]],
  };
}

describe('vegetation', () => {
  it('tells inside from outside a ring', () => {
    const ring = square('a', 'wood', 10).rings[0];
    expect(pointInRing({ x: 0, z: 0 }, ring)).toBe(true);
    expect(pointInRing({ x: 20, z: 0 }, ring)).toBe(false);
    expect(pointInRing({ x: 0, z: -40 }, ring)).toBe(false);
  });

  it('keeps every tree inside the polygon that planted it', () => {
    const area = square('wood-1', 'wood', 50);
    const trees = generateTrees([area]);
    expect(trees.length).toBeGreaterThan(0);
    expect(trees.every((tree) => pointInRing(tree, area.rings[0]))).toBe(true);
  });

  it('plants a wood far more densely than a park', () => {
    const wood = generateTrees([square('wood-1', 'wood', 50)]).length;
    const park = generateTrees([square('park-1', 'park', 50)]).length;
    expect(wood).toBeGreaterThan(park * 3);
  });

  it('leaves ground that has no trees on it alone', () => {
    // Nothing grows out of a car park, a rail yard or a lake shore's sand.
    for (const kind of ['industrial', 'railway', 'retail', 'quarry']) {
      expect(generateTrees([square(`${kind}-1`, kind, 60)])).toHaveLength(0);
    }
  });

  it('places the same trees in the same spots every time', () => {
    // The world is rebuilt constantly — every stream, every visibility change. A forest
    // that reshuffled on each rebuild would visibly crawl as you drove past it.
    const area = square('wood-1', 'wood', 40);
    expect(generateTrees([area])).toEqual(generateTrees([area]));
  });

  it('skews a Swedish forest coniferous and a park broadleaf', () => {
    const conifers = (kind: string) => {
      const trees = generateTrees([square(`${kind}-1`, kind, 60)]);
      return trees.filter((tree) => tree.kind === 'needleleaf').length / trees.length;
    };
    expect(conifers('forest')).toBeGreaterThan(0.6);
    expect(conifers('park')).toBeLessThan(0.4);
  });

  it('honours the instance limit', () => {
    expect(generateTrees([square('wood-1', 'wood', 300)], 25)).toHaveLength(25);
  });

  it('stays cheap on a polygon kilometres across', () => {
    // A protected area's bounding box at forest spacing is millions of cells, each a
    // point-in-polygon test, and this runs inside one slice of an incremental build.
    const started = performance.now();
    generateTrees([square('reserve-1', 'forest', 8_000)]);
    expect(performance.now() - started).toBeLessThan(150);
  });

  it('stands trees on the ground height it is given', () => {
    const trees = generateTrees([square('wood-1', 'wood', 30)], 4_000, () => 2.5);
    expect(trees.every((tree) => tree.y === 2.5)).toBe(true);
  });

  it('reads leaf type, height and girth off individually mapped trees', () => {
    const objects: WorldObject[] = [
      { id: 'tree-1', kind: 'tree', point: { x: 1, z: 2 }, properties: { leaf_type: 'needleleaved', height: '14' } },
      { id: 'tree-2', kind: 'tree', point: { x: 3, z: 4 }, properties: { leaf_type: 'broadleaved', circumference: '3.14' } },
      { id: 'bench-1', kind: 'bench', point: { x: 5, z: 6 }, properties: {} },
    ];
    const trees = mappedTrees(objects);

    expect(trees).toHaveLength(2);
    expect(trees[0].kind).toBe('needleleaf');
    expect(trees[0].height).toBe(14);
    expect(trees[1].kind).toBe('broadleaf');
    // Girth 3.14m is a 1m trunk diameter, so a crown of roughly 4m radius.
    expect(trees[1].radius).toBeCloseTo(4, 1);
  });

  it('falls back to the species name when leaf_type is missing', () => {
    const trees = mappedTrees([
      { id: 'tree-1', kind: 'tree', point: { x: 0, z: 0 }, properties: { genus: 'Pinus' } },
      { id: 'tree-2', kind: 'tree', point: { x: 1, z: 0 }, properties: { genus: 'Quercus' } },
    ]);
    expect(trees[0].kind).toBe('needleleaf');
    expect(trees[1].kind).toBe('broadleaf');
  });
});
