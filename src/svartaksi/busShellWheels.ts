/**
 * Splitting the authored bus's wheels out of its body, and driving them.
 *
 * `bus1.glb` is exported one mesh per material, so a wheel is not a node you can rotate:
 * its rim is a mesh of its own, its tyre and its six nuts share a buffer with the lamp
 * housings and the rubbing strips. The bootstrap read that as unsplittable and hid the
 * animated procedural wheels behind a static modelled body — the regression this module
 * exists to undo.
 *
 * The split is not a guess. Every number below was measured offline by
 * `scripts/inspect-bus-glb.mjs` and is written up, with its method, in
 * `docs/plans/2026-09-06-bus-wheel-asset-notes.md`. The rule it encodes is that a wheel is
 * a solid of revolution about its axle: a connected run of triangles belongs to a wheel
 * when *every* one of its vertices lies inside that wheel's cylinder. That admits the tyre
 * out of a shared buffer and rejects the wheel arch, which wraps outside the tyre at
 * nearly twice the radius, without either of them having to be named.
 *
 * Two separations are deliberate and load-bearing:
 *
 * - **Visual pivots are not physics axles.** The asset is a two-axle bus with a 5.55m
 *   wheelbase; `BUS_DIMENSIONS` describes a six-wheeled one with 7.4m, and that sheet is
 *   what the route profiler, the turning circle, the door placement and the collision
 *   envelope were all built against. The wheels are *drawn* where the asset's arches are
 *   and the bus still *drives* on the sheet. `suspensionIndex` is how a drawn wheel finds
 *   its travel in the sheet's six-entry array; the two inner rear duals simply have no
 *   visual counterpart.
 * - **The scale is baked, not inherited.** The shell body is fitted to the sheet by a
 *   non-uniform scale (see `busShellScale`). A rotation *inside* a non-uniformly scaled
 *   parent is not a rotation — it shears — so a wheel steering under that scale would go
 *   visibly elliptical at lock. The wheel geometry therefore carries the scale in its own
 *   vertices and its groups live in unscaled bus space.
 */
import * as THREE from 'three';

/** One wheel of the asset, hung off its own steer and roll pivots. */
export interface BusShellWheel {
  /** Turned about Y by the front wheels' Ackermann angle, and moved by suspension travel. */
  steer: THREE.Group;
  /** Spun about X by the wheel's absolute roll. Nested inside `steer` so a wheel at full
   * lock still rolls about its own (now turned) axis. */
  roll: THREE.Group;
  /** Where the hub sits in final bus coordinates with the suspension at rest. */
  restCenter: THREE.Vector3;
  front: boolean;
  /** +1 is the bus's left, matching `busModel`'s steer groups. */
  side: 1 | -1;
  /** Index into the six-entry travel array documented by `setBusWheelTravel`. */
  suspensionIndex: number;
}

/** Everything the wheels need for one frame, in the units the bus setters already use. */
export interface BusShellWheelState {
  /** Ackermann angle of the left front wheel, radians, positive turning left. */
  leftSteer: number;
  /** Ackermann angle of the right front wheel, radians. */
  rightSteer: number;
  /** Absolute roll about the axle, radians — not a delta. */
  rollRadians: number;
  /** Metres from each axle's resting height, in `BUS_WHEEL_LAYOUT` order. A short array
   * leaves the rest where they are, matching `setBusWheelTravel`. */
  travel: readonly number[];
}

/**
 * Puts every wheel where this frame says it should be.
 *
 * Displacement is always measured from `restCenter` rather than accumulated onto the
 * group's current position, so a dropped frame or a repeated call cannot make a wheel
 * drift down through the road. The hub's x and z are rewritten every call for the same
 * reason: they are what keeps a steering wheel turning about its own centre instead of
 * orbiting the bus.
 */
export function updateBusShellWheels(
  wheels: readonly BusShellWheel[], state: BusShellWheelState,
): void {
  for (const wheel of wheels) {
    wheel.steer.position.x = wheel.restCenter.x;
    wheel.steer.position.z = wheel.restCenter.z;
    if (wheel.suspensionIndex < state.travel.length) {
      wheel.steer.position.y = wheel.restCenter.y + state.travel[wheel.suspensionIndex];
    }
    wheel.steer.rotation.y = wheel.front ? (wheel.side > 0 ? state.leftSteer : state.rightSteer) : 0;
    wheel.roll.rotation.x = state.rollRadians;
  }
}

/** One measured wheel of the asset, in asset space: node transforms applied, scale not. */
export interface BusShellWheelHub {
  x: number;
  y: number;
  z: number;
  /** Distance from the axle to the furthest vertex of the tyre, metres. */
  radius: number;
  /** Half the wheel's width along the axle, metres — rim face to inner sidewall. */
  halfWidth: number;
  front: boolean;
  side: 1 | -1;
  suspensionIndex: number;
  /** Exact measured topology for assets whose wheel contract is known. Omit only for
   * synthetic or deliberately generic extraction callers. */
  expectedParts?: readonly BusShellWheelPartExpectation[];
}

export interface BusShellWheelPartExpectation {
  materialName: string;
  componentCount: number;
  triangleCount: number;
}

const BUS_SHELL_WHEEL_PARTS: readonly BusShellWheelPartExpectation[] = [
  // Component counts depend on connectedTriangleComponents' WELD_EPSILON_M as well as
  // the measured GLB. Re-run scripts/inspect-bus-glb.mjs when either contract changes.
  { materialName: 'black', componentCount: 7, triangleCount: 802 },
  { materialName: 'wheel', componentCount: 1, triangleCount: 970 },
];

/**
 * The four wheels of `bus1.glb` (sha256 95b9935d…), measured by
 * `scripts/inspect-bus-glb.mjs`.
 *
 * These are measurements, not tuning values: `x`, `y`, `z` are the hub's centre in asset
 * space, `radius` the furthest tyre vertex from the axle and `halfWidth` the wheel's
 * half-width along it. The asset's front is +Z and its left is +X, both established in the
 * asset notes from the lamp positions and three's handedness.
 *
 * `suspensionIndex` maps each drawn wheel onto `BUS_WHEEL_LAYOUT`. The asset has four
 * wheels and the sheet has six, so each rear wheel takes the travel of the outer wheel of
 * its own dual pair — they share an axle, so they share a height.
 */
export const BUS_SHELL_WHEEL_HUBS: readonly BusShellWheelHub[] = [
  {
    x: -1.0936018526554108, y: 0.4653582274913788, z: -2.455503463745117,
    radius: 0.4656279328320925, halfWidth: 0.203398197889328,
    front: false, side: -1, suspensionIndex: 0,
    expectedParts: BUS_SHELL_WHEEL_PARTS,
  },
  {
    x: 1.093330293893814, y: 0.4653582274913788, z: -2.455503463745117,
    radius: 0.4656279328320925, halfWidth: 0.20363447070121765,
    front: false, side: 1, suspensionIndex: 2,
    expectedParts: BUS_SHELL_WHEEL_PARTS,
  },
  {
    x: -1.0936018526554108, y: 0.4653582274913788, z: 2.7163796424865723,
    radius: 0.46564945755409926, halfWidth: 0.203398197889328,
    front: true, side: -1, suspensionIndex: 5,
    expectedParts: BUS_SHELL_WHEEL_PARTS,
  },
  {
    x: 1.093330293893814, y: 0.4653582274913788, z: 2.7163796424865723,
    radius: 0.46564945755409926, halfWidth: 0.20363447070121765,
    front: true, side: 1, suspensionIndex: 4,
    expectedParts: BUS_SHELL_WHEEL_PARTS,
  },
];

/**
 * Slack on the measured cylinder, in metres.
 *
 * The radius above *is* the tyre's furthest vertex, so a test at exactly that radius is a
 * float-equality test on a number that survived a Draco round trip. A centimetre is
 * comfortably more than that noise, and the asset has 43mm of clear air between the tyre
 * and the nearest vertex of the arch beside it (measured by the inspection script), so
 * this has a fourfold margin. Over-running it is not silent either: the arch would then
 * straddle a cylinder, and extraction throws rather than steering a wheel arch.
 */
const HUB_TOLERANCE_M = 0.01;

/**
 * Distance below which two vertices are the same corner, in metres.
 *
 * Draco quantises positions, so triangles that share a corner in the authoring package
 * come back agreeing only to about the quantisation step. This is far below any real
 * feature of a bus — a tyre sidewall is ~0.02m — and far above that noise.
 */
const WELD_EPSILON_M = 1e-4;

/**
 * Runs of triangles joined through shared corners, ascending, each triangle in exactly one.
 *
 * Welds on position first: an exporter is free to duplicate a vertex that two triangles
 * share, and without welding a tyre comes back as a hundred loose quads rather than a
 * wheel. Reads the geometry's own coordinates, so it is pure and needs no scene.
 */
export function connectedTriangleComponents(
  geometry: THREE.BufferGeometry, weldEpsilon = WELD_EPSILON_M,
): number[][] {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const slots = index ? index.count : position.count;
  const triangleCount = Math.floor(slots / 3);

  const parent = new Int32Array(position.count);
  for (let vertex = 0; vertex < parent.length; vertex += 1) parent[vertex] = vertex;
  const find = (vertex: number): number => {
    let root = vertex;
    while (parent[root] !== root) root = parent[root];
    while (parent[vertex] !== root) { const next = parent[vertex]; parent[vertex] = root; vertex = next; }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  const buckets = new Map<string, number>();
  const quantise = (value: number) => Math.round(value / weldEpsilon);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const key = `${quantise(position.getX(vertex))},${quantise(position.getY(vertex))},${quantise(position.getZ(vertex))}`;
    const seen = buckets.get(key);
    if (seen === undefined) buckets.set(key, vertex); else union(seen, vertex);
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const corners = [0, 1, 2].map((corner) => {
      const slot = triangle * 3 + corner;
      return index ? index.getX(slot) : slot;
    });
    union(corners[0], corners[1]);
    union(corners[0], corners[2]);
  }

  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const slot = triangle * 3;
    const root = find(index ? index.getX(slot) : slot);
    const group = groups.get(root);
    if (group) group.push(triangle); else groups.set(root, [triangle]);
  }
  // Ordered by first triangle so the output is stable however the map was filled.
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

export interface BusShellWheelExtraction {
  /** One per entry of `hubs`, in that order. */
  wheels: BusShellWheel[];
  /** Holds every steer group. Belongs somewhere the shell's scale does not reach. */
  group: THREE.Group;
  /** Geometries this call created. One owner disposes them; see `loadBusShell`. */
  geometries: THREE.BufferGeometry[];
  /** Geometries of meshes the split emptied and detached — the asset's rim mesh is
   * nothing but wheels, so it has no triangles left afterwards. They are no longer
   * reachable from the scene, so the same owner has to keep hold of them or they leak. */
  orphanedGeometries: THREE.BufferGeometry[];
}

/** A component of one source mesh, with the hub it was found to belong to. */
interface ClassifiedComponent {
  mesh: THREE.Mesh;
  triangles: number[];
  hub: number;
}

/** One source mesh, read once: its baked positions and the transform that produced them. */
interface SourceMesh {
  mesh: THREE.Mesh;
  /** Root-local positions, node transforms applied, scale *not* — the space the hubs
   * were measured in. */
  assetPositions: Float32Array;
  /** Root-local-to-final-bus, i.e. the node transform followed by the shell's scale. */
  bake: THREE.Matrix4;
  components: number[][];
}

/**
 * Lifts the wheels out of a loaded shell scene.
 *
 * Classification runs to completion, and is validated, before anything is mutated: an
 * asset this does not recognise leaves the scene exactly as it found it and throws, so
 * `loadBusShell().catch(...)` keeps the whole procedural bus rather than a bus with holes
 * where its wheels used to be.
 *
 * `scale` is the shell's per-axis fit onto `BUS_DIMENSIONS`, baked into the returned
 * geometry rather than inherited from a parent — see the module comment.
 */
export function extractBusShellWheels(
  root: THREE.Object3D,
  scale: THREE.Vector3,
  hubs: readonly BusShellWheelHub[] = BUS_SHELL_WHEEL_HUBS,
): BusShellWheelExtraction {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const scaleMatrix = new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z);

  const sources: SourceMesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    if (!position) return;
    const local = toRoot.clone().multiply(object.matrixWorld);
    const assetPositions = new Float32Array(position.count * 3);
    const point = new THREE.Vector3();
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(local);
      assetPositions.set([point.x, point.y, point.z], vertex * 3);
    }
    sources.push({
      mesh: object,
      assetPositions,
      bake: scaleMatrix.clone().multiply(local),
      components: connectedTriangleComponents(object.geometry),
    });
  });

  const classified: ClassifiedComponent[] = [];
  for (const source of sources) {
    const index = source.mesh.geometry.getIndex();
    for (const triangles of source.components) {
      let owner = -1;
      for (const [hubIndex, hub] of hubs.entries()) {
        let inside = 0;
        let outside = 0;
        for (const triangle of triangles) {
          for (let corner = 0; corner < 3; corner += 1) {
            const slot = triangle * 3 + corner;
            const vertex = index ? index.getX(slot) : slot;
            if (withinHub(source.assetPositions, vertex, hub)) inside += 1; else outside += 1;
          }
        }
        if (inside === 0) continue;
        if (outside > 0) {
          throw new Error(
            `[busShellWheels] a run of ${triangles.length} triangles in "${source.mesh.name}" straddles `
            + `the ${describeHub(hub)} wheel: ${inside} vertices inside its cylinder and ${outside} outside. `
            + 'The asset\'s wheels are not separable by the measured cylinders; re-export it with named '
            + 'wheel nodes, or re-measure with scripts/inspect-bus-glb.mjs.',
          );
        }
        owner = hubIndex;
        break;
      }
      if (owner >= 0) classified.push({ mesh: source.mesh, triangles, hub: owner });
    }
  }

  for (const [hubIndex, hub] of hubs.entries()) {
    if (classified.some((component) => component.hub === hubIndex)) continue;
    throw new Error(
      `[busShellWheels] no geometry inside the ${describeHub(hub)} wheel's measured cylinder. `
      + 'The asset does not carry the running gear these hubs were measured from; re-measure with '
      + 'scripts/inspect-bus-glb.mjs.',
    );
  }

  for (const [hubIndex, hub] of hubs.entries()) {
    if (!hub.expectedParts) continue;
    const actual = new Map<string, { componentCount: number; triangleCount: number }>();
    for (const component of classified.filter((candidate) => candidate.hub === hubIndex)) {
      const material = component.mesh.material;
      const materialName = Array.isArray(material)
        ? `<multiple:${material.map((entry) => entry.name).join(',')}>`
        : material.name;
      const count = actual.get(materialName) ?? { componentCount: 0, triangleCount: 0 };
      count.componentCount += 1;
      count.triangleCount += component.triangles.length;
      actual.set(materialName, count);
    }
    const matches = actual.size === hub.expectedParts.length
      && hub.expectedParts.every((expected) => {
        const found = actual.get(expected.materialName);
        return found?.componentCount === expected.componentCount
          && found.triangleCount === expected.triangleCount;
      });
    if (matches) continue;
    const describe = (parts: Iterable<readonly [
      string,
      { componentCount: number; triangleCount: number },
    ]>) =>
      [...parts].map(([name, value]) =>
        `${name}:${value.componentCount} components/${value.triangleCount} triangles`).join(', ');
    const expected = hub.expectedParts.map((part) => [part.materialName, part] as const);
    throw new Error(
      `[busShellWheels] topology mismatch at the ${describeHub(hub)} wheel; expected `
      + `{${describe(expected)}} but found {${describe(actual)}}. Re-measure the changed asset with `
      + 'scripts/inspect-bus-glb.mjs or re-export it with named wheel nodes.',
    );
  }

  // Validation is done. From here the scene is being changed, and every path completes.
  const group = new THREE.Group();
  group.name = 'bus:shell-wheels';
  const geometries: THREE.BufferGeometry[] = [];
  const orphanedGeometries: THREE.BufferGeometry[] = [];
  const wheels: BusShellWheel[] = [];

  for (const [hubIndex, hub] of hubs.entries()) {
    const restCenter = new THREE.Vector3(hub.x * scale.x, hub.y * scale.y, hub.z * scale.z);
    const steer = new THREE.Group();
    steer.name = `bus:shell-wheel-${describeHub(hub).replace(' ', '-')}`;
    steer.position.copy(restCenter);
    const roll = new THREE.Group();
    roll.name = `${steer.name}-axle`;
    steer.add(roll);
    group.add(steer);

    for (const source of sources) {
      const mine = classified.filter(
        (component) => component.hub === hubIndex && component.mesh === source.mesh,
      );
      if (mine.length === 0) continue;
      const geometry = copyTriangles(source, mine.flatMap((component) => component.triangles), restCenter);
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, source.mesh.material);
      mesh.name = `${steer.name}-${source.mesh.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      roll.add(mesh);
    }

    wheels.push({
      steer, roll, restCenter,
      front: hub.front, side: hub.side, suspensionIndex: hub.suspensionIndex,
    });
  }

  for (const source of sources) {
    const taken = new Set(classified
      .filter((component) => component.mesh === source.mesh)
      .flatMap((component) => component.triangles));
    if (taken.size === 0) continue;
    if (stripTriangles(source, taken)) orphanedGeometries.push(source.mesh.geometry);
  }

  return { wheels, group, geometries, orphanedGeometries };
}

/** Whether one vertex is inside a hub's cylinder, measured in asset space. */
function withinHub(positions: Float32Array, vertex: number, hub: BusShellWheelHub): boolean {
  const x = positions[vertex * 3];
  if (Math.abs(x - hub.x) > hub.halfWidth + HUB_TOLERANCE_M) return false;
  const radius = Math.hypot(positions[vertex * 3 + 1] - hub.y, positions[vertex * 3 + 2] - hub.z);
  return radius <= hub.radius + HUB_TOLERANCE_M;
}

function describeHub(hub: BusShellWheelHub): string {
  return `${hub.front ? 'front' : 'rear'} ${hub.side > 0 ? 'left' : 'right'}`;
}

/**
 * One wheel's triangles as a standalone geometry, in final bus coordinates about `origin`.
 *
 * Output is non-indexed for the reason `splitGeometryAlongAxis` gives: a wheel's triangles
 * are scattered through the source index buffer, so keeping the shared vertex buffer would
 * mean carrying the whole body's vertices in every wheel. A wheel is under a thousand
 * triangles and the duplication is cheaper than the bookkeeping to avoid it.
 *
 * Normals are transformed by the bake's normal matrix and renormalised: the shell's fit is
 * non-uniform, and a normal carried across unchanged would light the wheel differently
 * from the arch beside it.
 */
function copyTriangles(
  source: SourceMesh, triangles: readonly number[], origin: THREE.Vector3,
): THREE.BufferGeometry {
  const geometry = source.mesh.geometry;
  const index = geometry.getIndex();
  const output = new THREE.BufferGeometry();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(source.bake);
  const point = new THREE.Vector3();

  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name);
    const itemSize = attribute.itemSize;
    const values = new Float32Array(triangles.length * 3 * itemSize);
    let write = 0;
    for (const triangle of triangles) {
      for (let corner = 0; corner < 3; corner += 1) {
        const slot = triangle * 3 + corner;
        const vertex = index ? index.getX(slot) : slot;
        if (name === 'position' && itemSize === 3) {
          point.fromBufferAttribute(attribute, vertex).applyMatrix4(source.bake).sub(origin);
          values.set([point.x, point.y, point.z], write);
        } else if (name === 'normal' && itemSize === 3) {
          point.fromBufferAttribute(attribute, vertex).applyMatrix3(normalMatrix).normalize();
          values.set([point.x, point.y, point.z], write);
        } else {
          for (let item = 0; item < itemSize; item += 1) values[write + item] = attribute.getComponent(vertex, item);
        }
        write += itemSize;
      }
    }
    output.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
  }

  output.computeBoundingBox();
  output.computeBoundingSphere();
  return output;
}

/**
 * Removes the extracted triangles from the mesh they came from.
 *
 * Rewrites the index rather than the vertex buffer, so no body vertex moves as a side
 * effect of taking a wheel out — the triangles that remain are byte-identical to what the
 * loader produced.
 *
 * Returns whether the mesh was emptied and detached, which the asset's rim mesh is: it is
 * wheels and nothing else. A detached mesh is unreachable from the scene, so the caller
 * has to keep its geometry to dispose it.
 */
function stripTriangles(source: SourceMesh, taken: ReadonlySet<number>): boolean {
  const geometry = source.mesh.geometry;
  const index = geometry.getIndex();
  const slots = index ? index.count : geometry.getAttribute('position').count;
  const kept: number[] = [];
  for (let triangle = 0; triangle < Math.floor(slots / 3); triangle += 1) {
    if (taken.has(triangle)) continue;
    for (let corner = 0; corner < 3; corner += 1) {
      const slot = triangle * 3 + corner;
      kept.push(index ? index.getX(slot) : slot);
    }
  }
  geometry.setIndex(new THREE.BufferAttribute(
    geometry.getAttribute('position').count > 65535 ? new Uint32Array(kept) : new Uint16Array(kept), 1,
  ));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (kept.length > 0) return false;
  source.mesh.removeFromParent();
  return true;
}
