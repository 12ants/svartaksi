import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BUS_SHELL_WHEEL_HUBS,
  connectedTriangleComponents,
  extractBusShellWheels,
  updateBusShellWheels,
  type BusShellWheel,
  type BusShellWheelHub,
} from '@/svartaksi/busShellWheels';
import { isBusShellPart } from '@/svartaksi/busModel';

/**
 * A closed band of triangles around the X axis at `radius` — one connected component,
 * every vertex exactly `radius` from the hub axis. Stands in for a tyre: what matters to
 * the extraction is that it is round, connected, and shares a buffer with its neighbours.
 */
function wheelBand(
  center: { x: number; y: number; z: number },
  radius: number,
  halfWidth: number,
  segments = 8,
): number[] {
  const positions: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const near = [center.x - halfWidth, center.x + halfWidth];
    const ring = (angle: number, x: number) => [
      x, center.y + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius,
    ];
    positions.push(
      ...ring(a, near[0]), ...ring(b, near[0]), ...ring(a, near[1]),
      ...ring(b, near[0]), ...ring(b, near[1]), ...ring(a, near[1]),
    );
  }
  return positions;
}

/** An axis-aligned box as two triangles per face — one connected component of body trim. */
function trimBox(center: { x: number; y: number; z: number }, size: { x: number; y: number; z: number }): number[] {
  const [hx, hy, hz] = [size.x / 2, size.y / 2, size.z / 2];
  const corner = (sx: number, sy: number, sz: number) => [
    center.x + sx * hx, center.y + sy * hy, center.z + sz * hz,
  ];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1)),
    ...quad(corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)),
    ...quad(corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)),
    ...quad(corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1)),
  ];
}

/** Non-indexed geometry with a normal and a uv per corner, so both must survive the split. */
function geometryFrom(positions: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const vertices = positions.length / 3;
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  for (let vertex = 0; vertex < vertices; vertex += 1) {
    // Both are pure functions of the vertex's own position. A closed band repeats a
    // corner, so keying an attribute on the slot index rather than on the place would
    // make "did this vertex keep its uv?" ambiguous for the seam.
    const [x, y, z] = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    const direction = new THREE.Vector3(x || 1, y || 1, z || 1).normalize();
    normals.set([direction.x, direction.y, direction.z], vertex * 3);
    uvs.set([(x + 4) / 8, (y + 4) / 8], vertex * 2);
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * Two hubs, one per side of a single axle. Small enough to reason about and shaped like
 * the real table so the fixture exercises the same paths as `BUS_SHELL_WHEEL_HUBS`.
 */
const FIXTURE_HUBS: readonly BusShellWheelHub[] = [
  { x: -1, y: 0.5, z: 2, radius: 0.4, halfWidth: 0.2, front: true, side: -1, suspensionIndex: 5 },
  { x: 1, y: 0.5, z: 2, radius: 0.4, halfWidth: 0.2, front: true, side: 1, suspensionIndex: 4 },
];

/** The asset's own layout: every mesh is a flat sibling under a rotated, offset parent. */
function fixtureRoot(geometries: THREE.BufferGeometry[]): THREE.Object3D {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ name: 'shared' });
  for (const [index, geometry] of geometries.entries()) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Object_${index}`;
    // The asset applies a -90 degree X rotation and a millimetre offset to every node, so
    // the fixture does too: an extraction that reads geometry without baking the parent
    // transform puts the wheels on the roof.
    mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    mesh.position.set(-0.001, -0.001, 0.001);
    root.add(mesh);
  }
  return root;
}

/** The same rotation the fixture parents carry, for computing expected positions. */
function bake(position: THREE.Vector3, scale: THREE.Vector3): THREE.Vector3 {
  const matrix = new THREE.Matrix4()
    .makeRotationX(-Math.PI / 2)
    .setPosition(-0.001, -0.001, 0.001);
  return position.clone().applyMatrix4(matrix).multiply(scale);
}

/** A world-space box size expressed in node space: the parent's turn permutes the axes. */
function nodeSpaceSize(size: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: size.x, y: size.z, z: size.y };
}

/** Wheel bands and trim authored in *node* space, i.e. before the parent rotation. */
function nodeSpace(point: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // Inverse of the parents' transform. A -90 degree turn about X sends (x, y, z) to
  // (x, z, -y), so undoing it after removing the node offset sends (x, y, z) to (x, -z, y).
  return { x: point.x + 0.001, y: -point.z + 0.001, z: point.y + 0.001 };
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

describe('connectedTriangleComponents', () => {
  it('separates two wheels sharing one buffer', () => {
    const geometry = geometryFrom([
      ...wheelBand({ x: -1, y: 0.5, z: 2 }, 0.3, 0.15),
      ...wheelBand({ x: 1, y: 0.5, z: 2 }, 0.3, 0.15),
    ]);

    const components = connectedTriangleComponents(geometry);

    expect(components).toHaveLength(2);
    expect(components[0]).toHaveLength(16);
    expect(components[1]).toHaveLength(16);
    // Every triangle appears exactly once, and the lists are ascending.
    const all = components.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 32 }, (_, i) => i));
    for (const component of components) {
      expect([...component].sort((a, b) => a - b)).toEqual(component);
    }
  });

  it('welds coincident vertices, so a shared seam is one component not two', () => {
    // Two triangles that meet along an edge but do not share index slots.
    const geometry = geometryFrom([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 1, 0, 1, 1, 0,
    ]);

    expect(connectedTriangleComponents(geometry)).toHaveLength(1);
  });
});

describe('extractBusShellWheels', () => {
  /** A tyre mesh whose buffer also carries body trim, and a rim mesh of its own. */
  function assetLikeFixture() {
    const tyres = geometryFrom([
      ...wheelBand(nodeSpace({ x: -1, y: 0.5, z: 2 }), 0.35, 0.16),
      ...wheelBand(nodeSpace({ x: 1, y: 0.5, z: 2 }), 0.35, 0.16),
      // The wheel arch: it wraps outside the tyre, so no vertex of it is within the
      // cylinder, and it must stay with the body.
      ...trimBox(nodeSpace({ x: -1, y: 0.7, z: 2 }), nodeSpaceSize({ x: 0.5, y: 0.8, z: 1.2 })),
      ...trimBox(nodeSpace({ x: 1, y: 0.7, z: 2 }), nodeSpaceSize({ x: 0.5, y: 0.8, z: 1.2 })),
    ]);
    const rims = geometryFrom([
      ...wheelBand(nodeSpace({ x: -1.15, y: 0.5, z: 2 }), 0.2, 0.02),
      ...wheelBand(nodeSpace({ x: 1.15, y: 0.5, z: 2 }), 0.2, 0.02),
    ]);
    return { tyres, rims, root: fixtureRoot([tyres, rims]) };
  }

  it('claims every tyre and rim part and no body trim', () => {
    const { root } = assetLikeFixture();

    const { wheels } = extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS);

    expect(wheels).toHaveLength(2);
    for (const wheel of wheels) {
      const meshes: THREE.Mesh[] = [];
      wheel.roll.traverse((object) => { if (object instanceof THREE.Mesh) meshes.push(object); });
      // One tyre band and one rim band, from two different source meshes.
      expect(meshes).toHaveLength(2);
      const triangles = meshes.reduce(
        (sum, mesh) => sum + mesh.geometry.getAttribute('position').count / 3, 0,
      );
      expect(triangles).toBe(32);
    }
  });

  it('leaves the body trim in the source mesh, and leaves it where it was', () => {
    const { tyres, root } = assetLikeFixture();
    const before = Array.from(tyres.getAttribute('position').array as Float32Array);
    const beforeTriangles = tyres.getAttribute('position').count / 3;

    extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS);

    // Positions are never rewritten: the split removes triangles from the index, so a
    // body triangle cannot move by a millimetre as a side effect of taking a wheel out.
    expect(Array.from(tyres.getAttribute('position').array as Float32Array)).toEqual(before);
    const index = tyres.getIndex();
    expect(index).not.toBeNull();
    expect(index!.count / 3).toBe(beforeTriangles - 32);
  });

  it('gives every triangle to exactly one output', () => {
    const { tyres, rims, root } = assetLikeFixture();
    const total = (tyres.getAttribute('position').count + rims.getAttribute('position').count) / 3;

    const { wheels } = extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS);

    let extracted = 0;
    for (const wheel of wheels) {
      wheel.roll.traverse((object) => {
        if (object instanceof THREE.Mesh) extracted += object.geometry.getAttribute('position').count / 3;
      });
    }
    const kept = (tyres.getIndex()?.count ?? 0) / 3 + (rims.getIndex()?.count ?? 0) / 3;
    expect(extracted + kept).toBe(total);
  });

  it('re-centres each wheel on its own hub, so its neutral position is unchanged', () => {
    const scale = new THREE.Vector3(1.02, 0.97, 1.07);
    const { root } = assetLikeFixture();

    const { wheels } = extractBusShellWheels(root, scale, FIXTURE_HUBS);

    for (const wheel of wheels) {
      const hub = FIXTURE_HUBS.find((candidate) => candidate.side === wheel.side)!;
      expect(wheel.restCenter.x).toBeCloseTo(hub.x * scale.x, 5);
      expect(wheel.restCenter.y).toBeCloseTo(hub.y * scale.y, 5);
      expect(wheel.restCenter.z).toBeCloseTo(hub.z * scale.z, 5);

      wheel.roll.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const position = object.geometry.getAttribute('position');
        for (let vertex = 0; vertex < position.count; vertex += 1) {
          const local = new THREE.Vector3().fromBufferAttribute(position, vertex);
          const reconstructed = local.clone().add(wheel.restCenter);
          // Every vertex must sit on the hub's cylinder once put back where it came from.
          const radius = Math.hypot(reconstructed.y - hub.y * scale.y, reconstructed.z - hub.z * scale.z);
          expect(radius).toBeLessThanOrEqual(hub.radius * Math.max(scale.y, scale.z) + 1e-4);
          expect(Math.abs(reconstructed.x - hub.x * scale.x)).toBeLessThanOrEqual(hub.halfWidth * scale.x + 1e-4);
        }
      });
    }
  });

  it('carries the normals and uvs of each vertex across with it', () => {
    const { tyres, root } = assetLikeFixture();
    // Every source vertex, keyed on where it lands once the parent transform is baked in.
    const sourcePosition = tyres.getAttribute('position');
    const sourceNormal = tyres.getAttribute('normal');
    const sourceUv = tyres.getAttribute('uv');
    const expected = new Map<string, { normal: THREE.Vector3; uv: THREE.Vector2 }>();
    const key = (point: THREE.Vector3) => point.toArray().map((value) => value.toFixed(4)).join(',');
    for (let vertex = 0; vertex < sourcePosition.count; vertex += 1) {
      const baked = bake(new THREE.Vector3().fromBufferAttribute(sourcePosition, vertex), UNIT_SCALE);
      expected.set(key(baked), {
        normal: new THREE.Vector3().fromBufferAttribute(sourceNormal, vertex),
        uv: new THREE.Vector2().fromBufferAttribute(sourceUv, vertex),
      });
    }

    const { wheels } = extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS);

    let checked = 0;
    for (const wheel of wheels) {
      wheel.roll.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const position = object.geometry.getAttribute('position');
        const normal = object.geometry.getAttribute('normal');
        const uv = object.geometry.getAttribute('uv');
        expect(normal).toBeDefined();
        expect(uv).toBeDefined();
        for (let vertex = 0; vertex < position.count; vertex += 1) {
          const world = new THREE.Vector3().fromBufferAttribute(position, vertex).add(wheel.restCenter);
          const match = expected.get(key(world));
          if (!match) continue; // A rim vertex; this fixture only indexes the tyre mesh.
          expect(new THREE.Vector2().fromBufferAttribute(uv, vertex).distanceTo(match.uv)).toBeLessThan(1e-4);
          // The parent's rotation is baked in, so the normal turns with the vertex.
          const turned = match.normal.clone().applyQuaternion(
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
          );
          expect(new THREE.Vector3().fromBufferAttribute(normal, vertex).distanceTo(turned)).toBeLessThan(1e-4);
          checked += 1;
        }
      });
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('refuses an asset whose parts straddle a wheel, without touching the source', () => {
    // A bar that starts inside the cylinder and runs out through the arch: neither wheel
    // nor body, which is exactly the case where a silent guess would be wrong.
    const straddling = geometryFrom([
      ...wheelBand(nodeSpace({ x: -1, y: 0.5, z: 2 }), 0.35, 0.16),
      ...wheelBand(nodeSpace({ x: 1, y: 0.5, z: 2 }), 0.35, 0.16),
      // Rooted on the hub and running out past the tyre: some corners inside the
      // cylinder, some outside.
      ...trimBox(nodeSpace({ x: -1, y: 0.5, z: 2.5 }), nodeSpaceSize({ x: 0.3, y: 0.2, z: 1.2 })),
    ]);
    const before = (straddling.getIndex()?.count ?? straddling.getAttribute('position').count) / 3;
    const root = fixtureRoot([straddling]);

    expect(() => extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS)).toThrow(/straddle/i);
    // Nothing installed, nothing removed: the caller's catch keeps the procedural bus.
    expect((straddling.getIndex()?.count ?? straddling.getAttribute('position').count) / 3).toBe(before);
    expect(root.children).toHaveLength(1);
  });

  it('refuses an asset that is missing a wheel', () => {
    const oneWheel = geometryFrom([...wheelBand(nodeSpace({ x: -1, y: 0.5, z: 2 }), 0.35, 0.16)]);
    const root = fixtureRoot([oneWheel]);

    expect(() => extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS)).toThrow(/no geometry/i);
  });

  it('names its groups so the procedural shell hider does not claim them', () => {
    const { root } = assetLikeFixture();

    const { wheels, group } = extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS);

    expect(isBusShellPart(group.name)).toBe(false);
    for (const wheel of wheels) {
      expect(isBusShellPart(wheel.steer.name)).toBe(false);
      expect(isBusShellPart(wheel.roll.name)).toBe(false);
    }
  });

  it('hands back the geometries it created, so one owner can dispose them', () => {
    const { root } = assetLikeFixture();

    const { wheels, geometries } = extractBusShellWheels(root, UNIT_SCALE, FIXTURE_HUBS);

    const created = new Set<THREE.BufferGeometry>();
    for (const wheel of wheels) {
      wheel.roll.traverse((object) => { if (object instanceof THREE.Mesh) created.add(object.geometry); });
    }
    expect(new Set(geometries)).toEqual(created);
  });
});

describe('BUS_SHELL_WHEEL_HUBS', () => {
  it('holds the four hubs measured from bus1.glb', () => {
    // These are measurements, not tuning: they come from scripts/inspect-bus-glb.mjs and
    // are recorded in docs/plans/2026-09-06-bus-wheel-asset-notes.md. The exact numbers
    // are the point of the test — a typo here puts the wheels somewhere else.
    expect(BUS_SHELL_WHEEL_HUBS).toHaveLength(4);
    expect(BUS_SHELL_WHEEL_HUBS.map((hub) => [hub.front, hub.side, hub.suspensionIndex])).toEqual([
      [false, -1, 0],
      [false, 1, 2],
      [true, -1, 5],
      [true, 1, 4],
    ]);
    for (const hub of BUS_SHELL_WHEEL_HUBS) {
      expect(Math.abs(hub.x)).toBeCloseTo(1.0935, 3);
      expect(hub.y).toBeCloseTo(0.46536, 5);
      expect(Math.abs(hub.z)).toBeGreaterThan(2.4);
      expect(hub.radius).toBeCloseTo(0.4656, 3);
      expect(hub.halfWidth).toBeCloseTo(0.2035, 3);
      expect(Math.sign(hub.x)).toBe(hub.side);
      expect(hub.z > 0).toBe(hub.front);
    }
  });
});

describe('updateBusShellWheels', () => {
  function wheelAt(x: number, y: number, z: number, overrides: Partial<BusShellWheel> = {}): BusShellWheel {
    const steer = new THREE.Group();
    const roll = new THREE.Group();
    steer.add(roll);
    return {
      steer, roll,
      restCenter: new THREE.Vector3(x, y, z),
      front: true, side: 1, suspensionIndex: 4,
      ...overrides,
    };
  }

  it('steers, rolls and takes suspension travel without moving the hub', () => {
    const wheel = wheelAt(1, 0.5, 2);

    updateBusShellWheels([wheel], {
      leftSteer: 0.2, rightSteer: 0.15, rollRadians: 0.7,
      travel: [0, 0, 0, 0, 0.1, 0],
    });

    expect(wheel.steer.position.y).toBeCloseTo(wheel.restCenter.y + 0.1);
    expect(wheel.roll.rotation.x).toBeCloseTo(0.7);
    expect(wheel.steer.rotation.y).toBeCloseTo(0.2);
    // The hub does not orbit: rotation happens about the wheel's own centre.
    expect(wheel.steer.position.x).toBeCloseTo(1);
    expect(wheel.steer.position.z).toBeCloseTo(2);
    expect(wheel.roll.position.lengthSq()).toBe(0);
  });

  it('gives the right-hand wheel the right-hand Ackermann angle', () => {
    const wheel = wheelAt(-1, 0.5, 2, { side: -1, suspensionIndex: 5 });

    updateBusShellWheels([wheel], {
      leftSteer: 0.2, rightSteer: 0.15, rollRadians: 0, travel: [],
    });

    expect(wheel.steer.rotation.y).toBeCloseTo(0.15);
  });

  it('never steers a rear wheel', () => {
    const wheel = wheelAt(1, 0.5, -2, { front: false, suspensionIndex: 2 });

    updateBusShellWheels([wheel], {
      leftSteer: 0.4, rightSteer: 0.3, rollRadians: 0.1, travel: [0, 0, 0.05, 0, 0, 0],
    });

    expect(wheel.steer.rotation.y).toBe(0);
    expect(wheel.steer.position.y).toBeCloseTo(0.55);
    expect(wheel.roll.rotation.x).toBeCloseTo(0.1);
  });

  it('applies travel against restCenter rather than accumulating it', () => {
    const wheel = wheelAt(1, 0.5, 2);
    const state = { leftSteer: 0, rightSteer: 0, rollRadians: 0, travel: [0, 0, 0, 0, 0.1, 0] };

    updateBusShellWheels([wheel], state);
    updateBusShellWheels([wheel], state);
    updateBusShellWheels([wheel], state);

    expect(wheel.steer.position.y).toBeCloseTo(0.6);
  });

  it('leaves a wheel alone when travel has no entry for it', () => {
    const wheel = wheelAt(1, 0.5, 2);

    updateBusShellWheels([wheel], { leftSteer: 0, rightSteer: 0, rollRadians: 0, travel: [0, 0, 0, 0, 0.25] });
    expect(wheel.steer.position.y).toBeCloseTo(0.75);

    // A short array leaves the rest where they are, matching setBusWheelTravel.
    updateBusShellWheels([wheel], { leftSteer: 0, rightSteer: 0, rollRadians: 0, travel: [] });
    expect(wheel.steer.position.y).toBeCloseTo(0.75);
  });
});
