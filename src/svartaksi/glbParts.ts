/**
 * Splitting an authored GLB into the parts a vehicle needs to be able to move.
 *
 * Both vehicle assets in this project are exported *by material*, not by part: the Saab's
 * two `Cylinder` meshes are each a whole axle — both wheels of it in one geometry — and
 * the bus is fifteen meshes, one per material, each spanning the entire body. Nothing in
 * either file is a wheel you can rotate.
 *
 * A wheel that does not turn is the most obvious tell that a car is a prop rather than a
 * vehicle, so rather than accept the asset's grouping this module re-groups it: take a
 * geometry, cluster its triangles along one axis by which side of the gap they fall on,
 * and hand back one geometry per cluster, each re-centred on its own cluster so the
 * caller can hang it off a group and spin it about its own hub.
 *
 * Everything here is pure and reads plain attribute arrays, so the clustering — the part
 * with arithmetic that can be wrong — is testable without a GPU, a loader, or an asset.
 */
import * as THREE from 'three';

/** One cluster of triangles found along the split axis. */
export interface AxisCluster {
  /** Indices into the triangle list handed in, ascending. */
  triangles: number[];
  /** Midpoint of the cluster along the split axis. */
  center: number;
  min: number;
  max: number;
}

/**
 * Groups triangle centroids into runs separated by a gap.
 *
 * The rule is the simplest one that works on a wheel pair: sort the centroids, and start
 * a new cluster wherever the step to the next centroid exceeds `gap`. An axle is two
 * dense lumps of triangles with most of a track width of nothing between them, so any
 * `gap` between "thickness of a tyre" and "track width" separates them — and unlike
 * k-means the answer does not depend on a k, a seed, or how many wheels you guessed.
 *
 * Returns clusters in ascending axis order.
 */
export function clusterByGap(centroids: readonly number[], gap: number): AxisCluster[] {
  if (centroids.length === 0) return [];
  const order = centroids.map((_, index) => index).sort((a, b) => centroids[a] - centroids[b]);

  const clusters: AxisCluster[] = [];
  let current: number[] = [order[0]];
  for (let i = 1; i < order.length; i += 1) {
    if (centroids[order[i]] - centroids[order[i - 1]] > gap) {
      clusters.push(finishCluster(current, centroids));
      current = [];
    }
    current.push(order[i]);
  }
  clusters.push(finishCluster(current, centroids));
  return clusters;
}

function finishCluster(triangles: number[], centroids: readonly number[]): AxisCluster {
  let min = Infinity;
  let max = -Infinity;
  for (const triangle of triangles) {
    min = Math.min(min, centroids[triangle]);
    max = Math.max(max, centroids[triangle]);
  }
  // Sorted back into input order so writing the output buffer walks memory forwards, and
  // so the result is stable however the sort ordered equal centroids.
  triangles.sort((a, b) => a - b);
  return { triangles, center: (min + max) / 2, min, max };
}

export const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
export type AxisName = keyof typeof AXIS_INDEX;

/** Per-triangle centroid along one axis, for a geometry indexed or not. */
export function triangleCentroids(geometry: THREE.BufferGeometry, axis: AxisName): number[] {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const component = AXIS_INDEX[axis];
  const triangleCount = Math.floor((index ? index.count : position.count) / 3);

  const centroids: number[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    let sum = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const slot = triangle * 3 + corner;
      const vertex = index ? index.getX(slot) : slot;
      sum += position.getComponent(vertex, component);
    }
    centroids.push(sum / 3);
  }
  return centroids;
}

export interface SplitPart {
  /** The cluster's geometry, translated so `pivot` sits at its origin. */
  geometry: THREE.BufferGeometry;
  /** Where the part sat in the source geometry's space — where to hang the group. */
  pivot: THREE.Vector3;
}

/**
 * Splits `geometry` into one part per cluster found along `axis`.
 *
 * Each part is re-centred on its own bounding-box centre and its former centre handed
 * back as `pivot`, which is exactly what a wheel needs: parent the mesh to a group placed
 * at `pivot`, and rotating that group spins the wheel about its own axle rather than
 * about the car's centre.
 *
 * The output is non-indexed. A cluster's triangles are scattered through the source index
 * buffer, so keeping the shared vertex buffer would mean carrying every vertex of the
 * whole axle in every wheel; these meshes are a few hundred triangles, and the
 * duplication is cheaper than the bookkeeping to avoid it.
 */
export function splitGeometryAlongAxis(
  geometry: THREE.BufferGeometry,
  axis: AxisName,
  gap: number,
): SplitPart[] {
  const centroids = triangleCentroids(geometry, axis);
  const clusters = clusterByGap(centroids, gap);
  const index = geometry.getIndex();
  const attributeNames = Object.keys(geometry.attributes);

  return clusters.map((cluster) => {
    const output = new THREE.BufferGeometry();

    for (const name of attributeNames) {
      const attribute = geometry.getAttribute(name);
      const itemSize = attribute.itemSize;
      const values = new Float32Array(cluster.triangles.length * 3 * itemSize);
      let write = 0;
      for (const triangle of cluster.triangles) {
        for (let corner = 0; corner < 3; corner += 1) {
          const slot = triangle * 3 + corner;
          const vertex = index ? index.getX(slot) : slot;
          for (let item = 0; item < itemSize; item += 1) {
            values[write] = attribute.getComponent(vertex, item);
            write += 1;
          }
        }
      }
      output.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
    }

    output.computeBoundingBox();
    const pivot = new THREE.Vector3();
    output.boundingBox?.getCenter(pivot);
    output.translate(-pivot.x, -pivot.y, -pivot.z);
    output.computeBoundingBox();
    output.computeBoundingSphere();

    return { geometry: output, pivot };
  });
}

/**
 * Every mesh reachable from `root` whose material name matches one of `names`.
 *
 * The bus's meshes are named `Object_5`, `Object_7`, ... and carry all their meaning in
 * the material (`wheel`, `rearlght`, `glass`). Selecting by material name is the only
 * stable way to find anything in that asset, and it survives the exporter renumbering.
 */
export function findMeshesByMaterialName(root: THREE.Object3D, ...names: string[]): THREE.Mesh[] {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => wanted.has((material?.name ?? '').toLowerCase()))) {
      found.push(object);
    }
  });
  return found;
}

/** Every distinct material name on the tree — the asset's own parts list. */
export function materialNames(root: THREE.Object3D): string[] {
  const names = new Set<string>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) if (material?.name) names.add(material.name);
  });
  return [...names].sort();
}
