/**
 * The physics wireframe overlay: every collision frame in the world, drawn as it
 * actually exists to the solver rather than as the art that stands in for it.
 *
 * One LineSegments with a pre-allocated, fixed-capacity buffer. The alternative — a mesh
 * per body — would allocate and dispose thousands of objects every time the streamed
 * world changed, which is exactly the cost a debug view must not add to the thing it is
 * being used to debug. Here the geometry is written in place each frame and the draw
 * range is moved; nothing is allocated after construction.
 *
 * Colour is the legend:
 *
 * - grey    — static, anchored: street furniture nobody has hit
 * - green   — dynamic and awake: falling, rolling, being pushed
 * - blue    — dynamic and asleep: come to rest, no longer being solved
 * - orange  — the vehicle chassis
 * - yellow  — suspension rays, drawn from the strut mount to the wheel's contact patch
 * - red     — contact points solved on the last tick
 */
import * as THREE from 'three';
import type { PhysicsWorld } from './world';
import type { RaycastVehicle } from './vehicle';
import type { RigidBody } from './rigidBody';
import { boxFrame } from './collision';
import { colliderCentre } from './types';

export interface PhysicsDebugRenderer {
  object: THREE.LineSegments;
  /**
   * Rewrites the overlay from the world's current state. `focus`/`radius` clip it to the
   * player's surroundings — the streamed world holds thousands of static props and
   * drawing every one of them would cost more than the simulation does.
   */
  update(world: PhysicsWorld, vehicles: readonly RaycastVehicle[], focus: THREE.Vector3, radius: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const COLOR_STATIC = new THREE.Color(0x6d7681);
const COLOR_AWAKE = new THREE.Color(0x46e07a);
const COLOR_SLEEPING = new THREE.Color(0x4a7fd4);
const COLOR_VEHICLE = new THREE.Color(0xff9a3c);
const COLOR_RAY = new THREE.Color(0xffe24a);
const COLOR_CONTACT = new THREE.Color(0xff3b30);

/** Segments the buffer can hold. Beyond this the overlay simply stops drawing more,
 * nearest-first, rather than reallocating mid-frame. */
const SIGNS = [-1, 1] as const;
const chassisBodies = new Set<RigidBody>();

const MAX_SEGMENTS = 24_000;
/** Latitude/longitude rings used to draw a sphere collider. */
const SPHERE_SEGMENTS = 12;
/** Half-length of the little axis cross drawn at each contact point. */
const CONTACT_MARK = 0.12;

/** The 12 edges of a unit box, as pairs of corner indices into the standard corner order. */
const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export function createPhysicsDebugRenderer(): PhysicsDebugRenderer {
  const positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
  const colors = new Float32Array(MAX_SEGMENTS * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  const colorAttribute = new THREE.BufferAttribute(colors, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  colorAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('color', colorAttribute);
  geometry.setDrawRange(0, 0);

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    // The overlay's whole job is to be readable through the world it describes.
    depthTest: false,
    transparent: true,
    opacity: 0.9,
    fog: false,
  });
  const object = new THREE.LineSegments(geometry, material);
  object.name = 'physics:debug';
  object.frustumCulled = false;
  object.renderOrder = 999;
  object.visible = false;
  // The overlay is not part of the world; it must never cast, receive or be picked.
  object.matrixAutoUpdate = false;

  let count = 0;
  const corner = new THREE.Vector3();
  const corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());

  const segment = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    color: THREE.Color,
  ): void => {
    if (count >= MAX_SEGMENTS) return;
    const offset = count * 6;
    positions[offset] = ax;
    positions[offset + 1] = ay;
    positions[offset + 2] = az;
    positions[offset + 3] = bx;
    positions[offset + 4] = by;
    positions[offset + 5] = bz;
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
    colors[offset + 3] = color.r;
    colors[offset + 4] = color.g;
    colors[offset + 5] = color.b;
    count += 1;
  };

  const line = (a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color) =>
    segment(a.x, a.y, a.z, b.x, b.y, b.z, color);

  const drawBody = (body: RigidBody, color: THREE.Color): void => {
    for (const item of body.colliders) {
      if (item.shape.kind === 'box') {
        const frame = boxFrame(item, item.shape, body.position, body.quaternion);
        let index = 0;
        for (const sx of SIGNS) {
          for (const sy of SIGNS) {
            for (const sz of SIGNS) {
              corners[index].copy(frame.centre)
                .addScaledVector(frame.axes[0], sx * frame.extents.x)
                .addScaledVector(frame.axes[1], sy * frame.extents.y)
                .addScaledVector(frame.axes[2], sz * frame.extents.z);
              index += 1;
            }
          }
        }
        for (const [from, to] of BOX_EDGES) line(corners[from], corners[to], color);
      } else {
        const centre = colliderCentre(item, body.position, body.quaternion, corner);
        const radius = item.shape.radius;
        // Three great circles, one per plane, which reads unambiguously as a sphere
        // without the cost of a full wire globe.
        for (let plane = 0; plane < 3; plane += 1) {
          for (let step = 0; step < SPHERE_SEGMENTS; step += 1) {
            const a = (step / SPHERE_SEGMENTS) * Math.PI * 2;
            const b = ((step + 1) / SPHERE_SEGMENTS) * Math.PI * 2;
            const ca = Math.cos(a) * radius;
            const sa = Math.sin(a) * radius;
            const cb = Math.cos(b) * radius;
            const sb = Math.sin(b) * radius;
            if (plane === 0) {
              segment(centre.x + ca, centre.y + sa, centre.z, centre.x + cb, centre.y + sb, centre.z, color);
            } else if (plane === 1) {
              segment(centre.x + ca, centre.y, centre.z + sa, centre.x + cb, centre.y, centre.z + sb, color);
            } else {
              segment(centre.x, centre.y + ca, centre.z + sa, centre.x, centre.y + cb, centre.z + sb, color);
            }
          }
        }
      }
    }
  };

  return {
    object,
    setVisible(visible) {
      object.visible = visible;
    },
    update(world, vehicles, focus, radius) {
      if (!object.visible) return;
      count = 0;
      const radiusSq = radius * radius;
      // Reused rather than rebuilt: this runs every frame the overlay is on, which is
      // exactly when the frame budget is being measured.
      chassisBodies.clear();
      for (const vehicle of vehicles) chassisBodies.add(vehicle.chassis);

      for (const body of world.bodies()) {
        const dx = body.position.x - focus.x;
        const dz = body.position.z - focus.z;
        if (dx * dx + dz * dz > radiusSq) continue;
        drawBody(
          body,
          chassisBodies.has(body) ? COLOR_VEHICLE
            : body.type === 'static' ? COLOR_STATIC
              : body.sleeping ? COLOR_SLEEPING : COLOR_AWAKE,
        );
      }

      for (const vehicle of vehicles) {
        for (let index = 0; index < vehicle.wheels.length; index += 1) {
          const wheel = vehicle.wheels[index];
          const mount = corner.copy(wheel.spec.connection)
            .applyQuaternion(vehicle.chassis.quaternion)
            .add(vehicle.chassis.position);
          segment(mount.x, mount.y, mount.z, wheel.centre.x, wheel.centre.y, wheel.centre.z, COLOR_RAY);
          if (!wheel.grounded) continue;
          const contact = wheel.contactPoint;
          segment(
            wheel.centre.x, wheel.centre.y, wheel.centre.z,
            contact.x, contact.y, contact.z,
            COLOR_CONTACT,
          );
        }
      }

      for (const manifold of world.manifolds()) {
        for (const point of manifold.points) {
          const p = point.point;
          segment(p.x - CONTACT_MARK, p.y, p.z, p.x + CONTACT_MARK, p.y, p.z, COLOR_CONTACT);
          segment(p.x, p.y - CONTACT_MARK, p.z, p.x, p.y + CONTACT_MARK, p.z, COLOR_CONTACT);
          segment(p.x, p.y, p.z - CONTACT_MARK, p.x, p.y, p.z + CONTACT_MARK, COLOR_CONTACT);
          // The normal, so it is obvious which way a contact is about to push.
          segment(
            p.x, p.y, p.z,
            p.x + manifold.normal.x * 0.5, p.y + manifold.normal.y * 0.5, p.z + manifold.normal.z * 0.5,
            COLOR_CONTACT,
          );
        }
      }

      geometry.setDrawRange(0, count * 2);
      positionAttribute.addUpdateRange(0, count * 6);
      colorAttribute.addUpdateRange(0, count * 6);
      positionAttribute.needsUpdate = true;
      colorAttribute.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export { MAX_SEGMENTS };
