/**
 * A uniform grid over anything with a bounding box in the XZ plane, so a question about
 * one point or one small area doesn't have to walk the whole world to answer.
 *
 * Three separate stages of a world build were each doing exactly that, and each was the
 * dominant cost of the phase it ran in: pairing every bridge against every road to find
 * crossings, testing every lamp/shelter/post-box candidate against every road and every
 * building footprint, and testing every doorstep against every building and every water
 * polygon. On Svartaksi's opening snapshot — ~10 800 roads, ~9 800 buildings — those products
 * added up to tens of seconds of unyielded main-thread work, which is what the game
 * freezing on "Assembling streets, water and rooftops" actually was.
 *
 * The grid is deliberately plain. Buckets hold whatever items were handed in, an item
 * spanning several cells is filed in each of them, and a query visits every cell its own
 * box touches. Nothing here dedupes: every caller is either a short-circuiting "is any of
 * these a hit" test, for which a second visit costs one redundant comparison, or does its
 * own dedupe because it cares about the candidate list itself.
 */
import type { LocalPoint } from './types';

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The XZ bounding box of a ring or polyline, or null when there is nothing to bound
 * (an empty list, or coordinates that aren't finite). */
export function boundsOfPoints(points: readonly LocalPoint[]): Bounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minZ) && Number.isFinite(maxZ)
    ? { minX, maxX, minZ, maxZ }
    : null;
}

export interface SpatialGridOptions {
  /**
   * Side of one cell, in meters. Pick it from the size of the *queries*, not the items:
   * a cell much smaller than a typical query box means visiting many near-empty buckets,
   * and one much larger means each bucket holds items the query will only reject.
   */
  cellMeters: number;
  /**
   * Cells one item may be filed under before it is treated as unfileable and checked
   * against every query instead. Bounds the insertion cost of a pathological item — a
   * road drawn with two points a kilometre apart, a lake-sized footprint — which would
   * otherwise be copied into thousands of buckets.
   */
  maxCellsPerItem?: number;
}

const DEFAULT_MAX_CELLS_PER_ITEM = 48;

export interface SpatialGrid<T> {
  /** Visits items filed in any cell `box` touches, plus the unfileable ones, stopping at
   * the first `visit` that returns true. */
  anyNear(box: Bounds, visit: (item: T) => boolean): boolean;
  /** Visits every item filed in any cell `box` touches, plus the unfileable ones. An item
   * spanning several of those cells is visited once per cell — callers that care must
   * dedupe. */
  forEachNear(box: Bounds, visit: (item: T) => void): void;
}

export function createSpatialGrid<T>(
  items: readonly T[],
  boundsOf: (item: T) => Bounds | null,
  options: SpatialGridOptions,
): SpatialGrid<T> {
  const cellMeters = options.cellMeters;
  const maxCellsPerItem = options.maxCellsPerItem ?? DEFAULT_MAX_CELLS_PER_ITEM;
  const cellIndexAt = (value: number) => Math.floor(value / cellMeters);

  const boxes = items.map(boundsOf);
  let minCellX = 0;
  let maxCellX = -1;
  let minCellZ = 0;
  let maxCellZ = -1;
  let first = true;
  for (const box of boxes) {
    if (!box) continue;
    const loX = cellIndexAt(box.minX);
    const hiX = cellIndexAt(box.maxX);
    const loZ = cellIndexAt(box.minZ);
    const hiZ = cellIndexAt(box.maxZ);
    if (first) {
      minCellX = loX;
      maxCellX = hiX;
      minCellZ = loZ;
      maxCellZ = hiZ;
      first = false;
      continue;
    }
    if (loX < minCellX) minCellX = loX;
    if (hiX > maxCellX) maxCellX = hiX;
    if (loZ < minCellZ) minCellZ = loZ;
    if (hiZ > maxCellZ) maxCellZ = hiZ;
  }

  // One flat integer key per cell, so a lookup never has to hash a string. `columns` is
  // only the row stride, which is what makes the key scheme dependent on staying inside
  // the extent: a cell one column left of `minCellX` produces the same key as the last
  // column of the row below it. Insertion can never leave the extent (it *is* the extent
  // of the items), but a query box can be anywhere the caller likes, so both queries
  // below clamp to these bounds before building a key. Without that clamp a lamp
  // placement tested near the edge of the world would collide with a bucket of roads on
  // the far side of it and be rejected as blocked by a road that isn't there.
  const columns = Math.max(1, maxCellX - minCellX + 1);
  const keyAt = (cellX: number, cellZ: number) => (cellZ - minCellZ) * columns + (cellX - minCellX);

  const cells = new Map<number, T[]>();
  const everywhere: T[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const box = boxes[index];
    if (!box) continue;
    const item = items[index];
    const loX = cellIndexAt(box.minX);
    const hiX = cellIndexAt(box.maxX);
    const loZ = cellIndexAt(box.minZ);
    const hiZ = cellIndexAt(box.maxZ);
    if ((hiX - loX + 1) * (hiZ - loZ + 1) > maxCellsPerItem) {
      everywhere.push(item);
      continue;
    }
    for (let cellZ = loZ; cellZ <= hiZ; cellZ += 1) {
      for (let cellX = loX; cellX <= hiX; cellX += 1) {
        const key = keyAt(cellX, cellZ);
        const bucket = cells.get(key);
        if (bucket) bucket.push(item);
        else cells.set(key, [item]);
      }
    }
  }

  return {
    anyNear(box, visit) {
      const loX = Math.max(cellIndexAt(box.minX), minCellX);
      const hiX = Math.min(cellIndexAt(box.maxX), maxCellX);
      const loZ = Math.max(cellIndexAt(box.minZ), minCellZ);
      const hiZ = Math.min(cellIndexAt(box.maxZ), maxCellZ);
      for (let cellZ = loZ; cellZ <= hiZ; cellZ += 1) {
        for (let cellX = loX; cellX <= hiX; cellX += 1) {
          const bucket = cells.get(keyAt(cellX, cellZ));
          if (!bucket) continue;
          for (const item of bucket) if (visit(item)) return true;
        }
      }
      for (const item of everywhere) if (visit(item)) return true;
      return false;
    },
    forEachNear(box, visit) {
      const loX = Math.max(cellIndexAt(box.minX), minCellX);
      const hiX = Math.min(cellIndexAt(box.maxX), maxCellX);
      const loZ = Math.max(cellIndexAt(box.minZ), minCellZ);
      const hiZ = Math.min(cellIndexAt(box.maxZ), maxCellZ);
      for (let cellZ = loZ; cellZ <= hiZ; cellZ += 1) {
        for (let cellX = loX; cellX <= hiX; cellX += 1) {
          const bucket = cells.get(keyAt(cellX, cellZ));
          if (!bucket) continue;
          for (const item of bucket) visit(item);
        }
      }
      for (const item of everywhere) visit(item);
    },
  };
}

/**
 * Wraps `createSpatialGrid` in a cache keyed by the exact array the grid was built from.
 *
 * The callers here ask thousands of questions in a row about one snapshot's roads,
 * buildings or water, so the grid is built on the first question and reused for the rest,
 * then collected along with the array itself. Keying on identity means a caller that
 * *mutates* one of those arrays in place would keep the stale grid — nothing in this
 * codebase does (every such array is derived fresh per world build and read-only
 * afterwards), and a caller that needs a different set should hand over a new array
 * rather than edit one it has already asked about.
 */
export function memoizedSpatialGrid<Source extends object, T>(
  itemsOf: (source: Source) => readonly T[],
  boundsOf: (item: T) => Bounds | null,
  options: SpatialGridOptions,
): (source: Source) => SpatialGrid<T> {
  const cache = new WeakMap<Source, SpatialGrid<T>>();
  return (source) => {
    let grid = cache.get(source);
    if (!grid) {
      grid = createSpatialGrid(itemsOf(source), boundsOf, options);
      cache.set(source, grid);
    }
    return grid;
  };
}
