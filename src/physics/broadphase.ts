/**
 * Which pairs of bodies are close enough to be worth testing properly.
 *
 * A uniform grid over the ground plane, keyed by cell. The world this runs in is a city:
 * everything of interest sits within a few metres of y=0 and is spread over hundreds of
 * metres of x/z, so hashing in two dimensions and ignoring height loses nothing and
 * halves the bookkeeping.
 *
 * Static bodies — every lamp post, tree and signal in the streamed world, which is
 * thousands of them — are indexed once when the world changes and never again. Only the
 * handful of moving bodies are re-inserted each step, and only they generate queries, so
 * the per-step cost is proportional to what is actually moving rather than to how much
 * street furniture is loaded.
 */
import { aabbOverlaps, type Aabb } from './types';
import type { RigidBody } from './rigidBody';

export interface BodyPair {
  a: RigidBody;
  b: RigidBody;
}

export interface Broadphase {
  /** Re-indexes the static set. Call when bodies are added or removed, not per step. */
  setStatic(bodies: RigidBody[]): void;
  /** Every candidate pair among `movers`, and between each mover and the static set. */
  pairs(movers: RigidBody[]): BodyPair[];
  readonly cellSize: number;
}

function cellKey(x: number, z: number): number {
  // Two 16-bit cell coordinates packed into one integer key. At the default cell size
  // that covers ±260km, which is rather more of Stockholm than will ever be streamed.
  return ((x & 0xffff) << 16) | (z & 0xffff);
}

function forEachCell(bounds: Aabb, cellSize: number, visit: (key: number) => void): void {
  const minX = Math.floor(bounds.min.x / cellSize);
  const maxX = Math.floor(bounds.max.x / cellSize);
  const minZ = Math.floor(bounds.min.z / cellSize);
  const maxZ = Math.floor(bounds.max.z / cellSize);
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) visit(cellKey(x, z));
  }
}

export function createBroadphase(cellSize = 8): Broadphase {
  const staticCells = new Map<number, RigidBody[]>();

  return {
    cellSize,
    setStatic(bodies) {
      staticCells.clear();
      for (const body of bodies) {
        forEachCell(body.aabb, cellSize, (key) => {
          const bucket = staticCells.get(key);
          if (bucket) bucket.push(body);
          else staticCells.set(key, [body]);
        });
      }
    },
    pairs(movers) {
      const found: BodyPair[] = [];
      // A body spanning several cells appears in each of them, so the same static
      // neighbour can be reached more than once for the same mover. Deduplicated per
      // mover rather than globally: the set is cleared between movers, so it stays the
      // size of one body's neighbourhood instead of the whole frame's pair list.
      const seen = new Set<RigidBody>();
      for (let i = 0; i < movers.length; i += 1) {
        const mover = movers[i];
        for (let j = i + 1; j < movers.length; j += 1) {
          if (aabbOverlaps(mover.aabb, movers[j].aabb)) found.push({ a: mover, b: movers[j] });
        }
        seen.clear();
        forEachCell(mover.aabb, cellSize, (key) => {
          const bucket = staticCells.get(key);
          if (!bucket) return;
          for (const other of bucket) {
            if (seen.has(other)) continue;
            seen.add(other);
            if (aabbOverlaps(mover.aabb, other.aabb)) found.push({ a: mover, b: other });
          }
        });
      }
      return found;
    },
  };
}
