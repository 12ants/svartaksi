/**
 * Plants trees inside the landuse polygons OSM already gives us, so a wood renders as
 * a wood rather than a green mound and a park has something standing in it.
 *
 * OSM maps individual trees only where a mapper bothered (`natural=tree`), which in
 * practice means a handful of street trees downtown and nothing at all in the forests
 * that cover most of Svartaksi. The polygons, by contrast, are mapped everywhere — so the
 * species mix, density and extent all come from real data even though the individual
 * trunks are procedural. Same division of labour as streetLights.ts: pure geometry in,
 * placements out, with threeWorld turning placements into instanced meshes.
 */
import type { LocalPoint, WorldArea, WorldObject } from './types';
// One point-in-ring for the whole codebase — see geo.ts. Re-exported because the tree
// scatter is where callers expect to find it.
export { pointInRing } from './geo';
import { pointInRing } from './geo';

export type TreeKind = 'needleleaf' | 'broadleaf';

export interface TreePlacement {
  x: number;
  z: number;
  /** Ground height at this point. Landuse polygons are extruded solids, not decals —
   * a forest rises up to 3.6m — so a tree planted at y=0 would be buried in the very
   * polygon that placed it. */
  y: number;
  kind: TreeKind;
  /** Meters, trunk base to crown top. */
  height: number;
  /** Crown radius in meters. */
  radius: number;
  yaw: number;
  /** 0..1 position within the foliage palette, so a stand of trees is not one colour. */
  tint: number;
}

interface Species {
  /** Trees per hectare. Zero means this landuse kind gets none. */
  density: number;
  /** Share of trees that are conifers — Svartaksi is largely pine and spruce, so the
   * forests skew hard that way while parks are planted broadleaf. */
  needleleafShare: number;
  minHeight: number;
  maxHeight: number;
}

const SPECIES: Record<string, Species> = {
  forest: { density: 90, needleleafShare: 0.78, minHeight: 9, maxHeight: 19 },
  wood: { density: 90, needleleafShare: 0.7, minHeight: 8, maxHeight: 18 },
  scrub: { density: 55, needleleafShare: 0.15, minHeight: 1.6, maxHeight: 3.4 },
  heath: { density: 18, needleleafShare: 0.1, minHeight: 1.2, maxHeight: 2.4 },
  orchard: { density: 70, needleleafShare: 0, minHeight: 3.5, maxHeight: 5.5 },
  park: { density: 13, needleleafShare: 0.22, minHeight: 6, maxHeight: 13 },
  garden: { density: 9, needleleafShare: 0.2, minHeight: 3, maxHeight: 7 },
  cemetery: { density: 10, needleleafShare: 0.35, minHeight: 6, maxHeight: 12 },
  village_green: { density: 6, needleleafShare: 0.15, minHeight: 5, maxHeight: 10 },
  recreation_ground: { density: 5, needleleafShare: 0.2, minHeight: 5, maxHeight: 11 },
  allotments: { density: 6, needleleafShare: 0.05, minHeight: 2.5, maxHeight: 5 },
  grass: { density: 2, needleleafShare: 0.15, minHeight: 5, maxHeight: 10 },
  meadow: { density: 1.5, needleleafShare: 0.1, minHeight: 5, maxHeight: 9 },
  wetland: { density: 6, needleleafShare: 0.05, minHeight: 2, maxHeight: 5 },
};

/** Trees per polygon, whatever its area — one enormous forest polygon must not spend
 * the entire instance budget before the next one is reached. */
const MAX_TREES_PER_AREA = 900;

/**
 * Grid cells examined per polygon. A protected-area polygon can be kilometres across,
 * and at forest spacing its bounding box is millions of cells — each one a
 * point-in-polygon test. The tree cap alone does not bound that, because a long thin
 * polygon rejects most of its own bounding box before placing anything. Coarsening the
 * grid to fit this budget keeps the work proportional to what actually gets rendered;
 * the visible result is a sparser stand, which is the right trade at that size anyway.
 */
const MAX_CELLS_PER_AREA = 40_000;

/** Deterministic 0..1 from a string and two integers. The whole point of hashing the
 * area id in is that a tree stays put across rebuilds: streaming the world again, or
 * re-evaluating visibility, must not shuffle the forest. */
export function hashed(seed: string, a: number, b: number): number {
  let hash = 2_166_136_261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  hash = Math.imul(hash ^ a, 16_777_619);
  hash = Math.imul(hash ^ b, 16_777_619);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4_294_967_296;
}

/** Ray casting: counts ring edges crossed by a ray heading in +x from the point. */

/**
 * Scatters trees over a jittered grid clipped to each polygon. A grid keeps spacing
 * believable — trees never clump into a solid wall or leave a suspiciously bare
 * rectangle, which is what uniform random sampling does at these densities — and the
 * per-cell jitter is what stops it reading as a plantation.
 *
 * `limit` caps the total, applied after placement so it trims evenly from the far end
 * of the list rather than starving whichever polygons come last in the data.
 */
/**
 * Areas per yield. An area is a whole polygon's worth of scattering, so the chunk is
 * smaller than the road builders' — a hundred forests between two yields would be the
 * dropped frame this exists to prevent.
 */
const TREE_AREA_CHUNK = 16;

/**
 * The incremental form, which is the real implementation.
 *
 * Scattering trees was one of the stages that ran whole between two of the world
 * builder's yields, and on a snapshot with real forests in it that is tens of thousands
 * of `pointInRing` tests in one unbroken block. It is safe to cut up at any area
 * boundary: every area computes its own bounds, spacing and grid, the jitter is hashed
 * from the area's id and its cell rather than drawn from a running generator, and nothing
 * carries from one area to the next. Pausing therefore cannot move a single tree.
 */
export function* generateTreesJob(
  areas: WorldArea[],
  limit = 4_000,
  // Sampled per tree, not per polygon: landuse mounds slope down at their own edges, so a
  // tree taking its whole area's height would stand on stilts anywhere near the boundary.
  groundHeight: (point: LocalPoint) => number = () => 0,
): Generator<void, TreePlacement[], void> {
  const trees: TreePlacement[] = [];
  for (let areaIndex = 0; areaIndex < areas.length; areaIndex += 1) {
    if (areaIndex > 0 && areaIndex % TREE_AREA_CHUNK === 0) yield;
    const area = areas[areaIndex];
    const species = SPECIES[area.kind];
    const ring = area.rings[0];
    if (!species || species.density <= 0 || !ring || ring.length < 3) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of ring) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.z < minZ) minZ = point.z;
      if (point.z > maxZ) maxZ = point.z;
    }
    const width = maxX - minX;
    const depth = maxZ - minZ;
    if (!(width > 0) || !(depth > 0)) continue;

    // One tree per cell at the target density: 10000 m^2 per hectare.
    const targetSpacing = Math.sqrt(10_000 / species.density);
    const spacing = Math.max(
      targetSpacing,
      Math.sqrt((width * depth) / MAX_CELLS_PER_AREA),
    );
    const columns = Math.ceil(width / spacing);
    const rows = Math.ceil(depth / spacing);
    let placed = 0;

    for (let row = 0; row < rows && placed < MAX_TREES_PER_AREA; row += 1) {
      for (let column = 0; column < columns && placed < MAX_TREES_PER_AREA; column += 1) {
        const jitterX = hashed(area.id, column, row);
        const jitterZ = hashed(area.id, row, column + 977);
        const point = {
          x: minX + (column + jitterX) * spacing,
          z: minZ + (row + jitterZ) * spacing,
        };
        if (!pointInRing(point, ring)) continue;

        const roll = hashed(area.id, column + 5_003, row + 17);
        const size = hashed(area.id, row + 8_191, column + 31);
        const kind: TreeKind = roll < species.needleleafShare ? 'needleleaf' : 'broadleaf';
        const height = species.minHeight + size * (species.maxHeight - species.minHeight);
        trees.push({
          x: point.x,
          z: point.z,
          y: groundHeight(point),
          kind,
          height,
          // Conifers are tall and narrow, broadleaves round and wide.
          radius: height * (kind === 'needleleaf' ? 0.2 : 0.34) * (0.8 + jitterX * 0.4),
          yaw: jitterZ * Math.PI * 2,
          tint: hashed(area.id, column + 41, row + 4_099),
        });
        placed += 1;
      }
    }
  }
  return trees.length > limit ? trees.slice(0, limit) : trees;
}

/** The all-at-once form, for callers with no frame to protect. Drains the generator, so a
 * sliced build and an eager one cannot scatter different trees. */
export function generateTrees(
  areas: WorldArea[],
  limit = 4_000,
  groundHeight: (point: LocalPoint) => number = () => 0,
): TreePlacement[] {
  const job = generateTreesJob(areas, limit, groundHeight);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

const NEEDLELEAF_GENERA = /pine|spruce|fir|larch|juniper|pinus|picea|abies|larix|juniperus|thuja/;

/**
 * The individually mapped trees (`natural=tree`), which carry far better data than
 * anything procedural: a real position, and often `leaf_type`, `height` or
 * `circumference`. Rendered through the same pipeline as the scattered ones so a street
 * tree and a forest tree are one instanced batch, not two.
 */
export function mappedTrees(
  objects: WorldObject[],
  groundHeight: (point: LocalPoint) => number = () => 0,
): TreePlacement[] {
  const trees: TreePlacement[] = [];
  for (const object of objects) {
    if (object.kind !== 'tree') continue;
    const tags = object.properties;
    const leafType = String(tags.leaf_type ?? '').toLowerCase();
    const taxon = String(tags.genus ?? tags.species ?? tags.taxon ?? '').toLowerCase();
    const kind: TreeKind = leafType === 'needleleaved' ? 'needleleaf'
      : leafType === 'broadleaved' ? 'broadleaf'
        : NEEDLELEAF_GENERA.test(taxon) ? 'needleleaf' : 'broadleaf';

    const jitter = hashed(object.id, 0, 0);
    const tagged = Number.parseFloat(String(tags.height));
    // `circumference` is trunk girth in meters at breast height; the rule of thumb that
    // crown radius runs about 4x trunk diameter is close enough for a silhouette.
    const girth = Number.parseFloat(String(tags.circumference));
    const height = Number.isFinite(tagged) && tagged > 1 && tagged < 60
      ? tagged
      : (kind === 'needleleaf' ? 9 : 7) + jitter * 6;
    const crown = Number.isFinite(girth) && girth > 0
      ? Math.max(1, (girth / Math.PI) * 4)
      : height * (kind === 'needleleaf' ? 0.22 : 0.36);

    trees.push({
      x: object.point.x,
      z: object.point.z,
      y: groundHeight(object.point),
      kind,
      height,
      radius: crown,
      yaw: hashed(object.id, 1, 0) * Math.PI * 2,
      tint: hashed(object.id, 2, 0),
    });
  }
  return trees;
}
