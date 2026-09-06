import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boxCorners, collideBodies, type Manifold } from '../../src/physics/collision';
import { createBody } from '../../src/physics/rigidBody';
import { box, collider, sphere, type BoxShape } from '../../src/physics/types';

function boxBody(id: string, half: [number, number, number], position: [number, number, number], yaw = 0) {
  return createBody({
    id,
    colliders: [collider(box(...half))],
    position: new THREE.Vector3(...position),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
  });
}

function collide(a: ReturnType<typeof boxBody>, b: ReturnType<typeof boxBody>): Manifold[] {
  const out: Manifold[] = [];
  collideBodies(a, b, out);
  return out;
}

describe('box against box', () => {
  it('finds nothing when they are apart', () => {
    expect(collide(boxBody('a', [1, 1, 1], [0, 0, 0]), boxBody('b', [1, 1, 1], [3, 0, 0]))).toHaveLength(0);
  });

  it('reports the shallowest overlap as the contact direction', () => {
    // Overlapping 0.5 along x and 1.5 along z: x is the way out.
    const manifolds = collide(
      boxBody('a', [1, 1, 1], [0, 0, 0]),
      boxBody('b', [1, 1, 1], [1.5, 0, 0.5]),
    );
    expect(manifolds).toHaveLength(1);
    expect(Math.abs(manifolds[0].normal.x)).toBeCloseTo(1, 6);
    expect(manifolds[0].points[0].penetration).toBeCloseTo(0.5, 5);
  });

  it('points its normal from a towards b', () => {
    const manifolds = collide(boxBody('a', [1, 1, 1], [0, 0, 0]), boxBody('b', [1, 1, 1], [-1.7, 0, 0]));
    expect(manifolds[0].normal.x).toBeLessThan(0);
  });

  it('builds a contact patch, not a point, for a face-on overlap', () => {
    const manifolds = collide(boxBody('a', [2, 1, 2], [0, 0, 0]), boxBody('b', [1, 1, 1], [0, 1.8, 0]));
    // A box resting squarely on another shares a whole face, and the clipped patch is
    // what lets the solver hold it level rather than letting it rock on one corner.
    expect(manifolds[0].points.length).toBeGreaterThanOrEqual(4);
    expect(manifolds[0].normal.y).toBeCloseTo(1, 6);
  });

  it('separates boxes that only miss once one is rotated', () => {
    const straight = collide(boxBody('a', [1, 0.2, 1], [0, 0, 0]), boxBody('b', [1, 0.2, 1], [2.4, 0, 0]));
    expect(straight).toHaveLength(0);
    const turned = collide(
      boxBody('a', [1, 0.2, 1], [0, 0, 0]),
      boxBody('b', [1, 0.2, 1], [2.4, 0, 0], Math.PI / 4),
    );
    // Turned 45 degrees, b reaches 1.41m along x rather than 1m, and its corner crosses
    // the 0.4m gap that separated them squared up.
    expect(turned.length).toBeGreaterThan(0);
  });

  it('produces one manifold per pair of colliders on compound bodies', () => {
    const post = createBody({
      id: 'post',
      colliders: [
        collider(box(0.1, 1.8, 0.1), new THREE.Vector3(0, 1.8, 0)),
        collider(box(0.2, 0.6, 0.15), new THREE.Vector3(0, 3.15, 0)),
      ],
    });
    const wall = createBody({
      id: 'wall',
      colliders: [collider(box(2, 4, 0.2), new THREE.Vector3(0, 2, 0.2))],
    });
    expect(collide(post, wall).length).toBe(2);
  });
});

describe('sphere against box', () => {
  it('finds the overlap and orients the normal from a to b', () => {
    const ball = createBody({
      id: 'ball',
      colliders: [collider(sphere(0.5))],
      position: new THREE.Vector3(1.2, 0, 0),
    });
    const wall = boxBody('wall', [1, 1, 1], [0, 0, 0]);
    const [manifold] = collide(ball, wall);
    expect(manifold.a.id).toBe('ball');
    // From the ball towards the wall is -x.
    expect(manifold.normal.x).toBeCloseTo(-1, 5);
    expect(manifold.points[0].penetration).toBeCloseTo(0.3, 5);
  });

  it('pushes a sphere whose centre is inside the box out of the nearest face', () => {
    const ball = createBody({
      id: 'ball',
      colliders: [collider(sphere(0.2))],
      position: new THREE.Vector3(0, 0.9, 0),
    });
    const block = boxBody('block', [1, 1, 1], [0, 0, 0]);
    const [manifold] = collide(block, ball);
    expect(manifold.normal.y).toBeCloseTo(1, 5);
  });

  it('finds nothing when the sphere clears the box', () => {
    const ball = createBody({
      id: 'ball',
      colliders: [collider(sphere(0.2))],
      position: new THREE.Vector3(0, 2, 0),
    });
    expect(collide(ball, boxBody('block', [1, 1, 1], [0, 0, 0]))).toHaveLength(0);
  });
});

describe('sphere against sphere', () => {
  it('reports the overlap along the line of centres', () => {
    const a = createBody({ id: 'a', colliders: [collider(sphere(1))] });
    const b = createBody({
      id: 'b',
      colliders: [collider(sphere(1))],
      position: new THREE.Vector3(0, 0, 1.5),
    });
    const [manifold] = collide(a, b);
    expect(manifold.normal.z).toBeCloseTo(1, 6);
    expect(manifold.points[0].penetration).toBeCloseTo(0.5, 6);
  });
});

describe('boxCorners', () => {
  it('returns the eight corners of the box in world space', () => {
    const item = collider(box(1, 2, 3));
    const corners = boxCorners(item, item.shape as BoxShape, new THREE.Vector3(10, 0, 0), new THREE.Quaternion());
    expect(corners).toHaveLength(8);
    expect(Math.min(...corners.map((corner) => corner.x))).toBeCloseTo(9, 6);
    expect(Math.max(...corners.map((corner) => corner.y))).toBeCloseTo(2, 6);
    expect(Math.max(...corners.map((corner) => corner.z))).toBeCloseTo(3, 6);
  });
});
