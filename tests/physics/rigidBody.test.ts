import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyImpulse,
  computeInertia,
  createBody,
  integratePosition,
  integrateVelocity,
  pointVelocity,
  setBodyDynamic,
  SLEEP_DELAY,
  updateSleep,
} from '../../src/physics/rigidBody';
import { box, collider, sphere } from '../../src/physics/types';

describe('computeInertia', () => {
  it('matches the closed form for a solid box about its own centre', () => {
    const inertia = computeInertia([collider(box(0.5, 1, 2))], 12);
    // I_x = m/12 * (h^2 + d^2) with h = 2, d = 4.
    expect(inertia.x).toBeCloseTo((12 / 12) * (4 + 16), 6);
    expect(inertia.y).toBeCloseTo((12 / 12) * (1 + 16), 6);
    expect(inertia.z).toBeCloseTo((12 / 12) * (1 + 4), 6);
  });

  it('adds the parallel-axis term for an offset part', () => {
    const centred = computeInertia([collider(box(0.1, 0.1, 0.1))], 5);
    const raised = computeInertia([collider(box(0.1, 0.1, 0.1), new THREE.Vector3(0, 3, 0))], 5);
    // A part three metres up resists rotation about x and z by an extra m*r^2, and about
    // y — the axis it sits on — not at all.
    expect(raised.x - centred.x).toBeCloseTo(5 * 9, 6);
    expect(raised.z - centred.z).toBeCloseTo(5 * 9, 6);
    expect(raised.y).toBeCloseTo(centred.y, 6);
  });

  it('splits mass between parts by volume', () => {
    const single = computeInertia([collider(sphere(1))], 10);
    const doubled = computeInertia([collider(sphere(1)), collider(sphere(1))], 10);
    // Two identical spheres at the same place carry half the mass each, so the total is
    // the same as one sphere with all of it.
    expect(doubled.x).toBeCloseTo(single.x, 6);
  });
});

describe('createBody', () => {
  it('gives a static body infinite mass and no inertia', () => {
    const body = createBody({ id: 'a', type: 'static', colliders: [collider(box(1, 1, 1))] });
    expect(body.invMass).toBe(0);
    expect(body.invInertiaLocal.length()).toBe(0);
  });

  it('bounds a body by every collider it carries', () => {
    const body = createBody({
      id: 'a',
      colliders: [collider(box(0.1, 2, 0.1)), collider(box(0.5, 0.2, 0.3), new THREE.Vector3(0, 4, 0))],
    });
    expect(body.aabb.min.y).toBeCloseTo(-2, 6);
    expect(body.aabb.max.y).toBeCloseTo(4.2, 6);
    expect(body.aabb.max.x).toBeCloseTo(0.5, 6);
  });

  it('expands the bounds of a rotated box to its projected extent', () => {
    const body = createBody({
      id: 'a',
      colliders: [collider(box(1, 1, 1))],
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
    });
    expect(body.aabb.max.x).toBeCloseTo(Math.SQRT2, 5);
  });
});

describe('applyImpulse', () => {
  it('changes only linear velocity through the centre of mass', () => {
    const body = createBody({ id: 'a', mass: 4, colliders: [collider(box(1, 1, 1))] });
    applyImpulse(body, new THREE.Vector3(8, 0, 0), body.position.clone());
    expect(body.linearVelocity.x).toBeCloseTo(2, 6);
    expect(body.angularVelocity.length()).toBeCloseTo(0, 6);
  });

  it('spins a body struck off its centre', () => {
    const body = createBody({ id: 'a', mass: 4, colliders: [collider(box(1, 1, 1))] });
    applyImpulse(body, new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    // A push along +z applied out at +x turns the body about -y.
    expect(body.angularVelocity.y).toBeLessThan(0);
    expect(body.linearVelocity.z).toBeCloseTo(0.25, 6);
  });

  it('does nothing to a static body', () => {
    const body = createBody({ id: 'a', type: 'static', colliders: [collider(box(1, 1, 1))] });
    applyImpulse(body, new THREE.Vector3(100, 0, 0), new THREE.Vector3(1, 0, 0));
    expect(body.linearVelocity.length()).toBe(0);
  });
});

describe('pointVelocity', () => {
  it('adds the velocity the body\'s rotation gives that point', () => {
    const body = createBody({ id: 'a', mass: 1, colliders: [collider(box(1, 1, 1))] });
    body.linearVelocity.set(1, 0, 0);
    body.angularVelocity.set(0, 2, 0);
    const velocity = pointVelocity(body, new THREE.Vector3(0, 0, 1), new THREE.Vector3());
    // omega x r = (0,2,0) x (0,0,1) = (2,0,0), on top of the body's own metre per second.
    expect(velocity.x).toBeCloseTo(3, 6);
  });
});

describe('integration', () => {
  it('accelerates under gravity and moves by the result', () => {
    const body = createBody({ id: 'a', mass: 1, colliders: [collider(sphere(0.5))], linearDamping: 0 });
    const gravity = new THREE.Vector3(0, -10, 0);
    integrateVelocity(body, gravity, 0.1);
    expect(body.linearVelocity.y).toBeCloseTo(-1, 6);
    integratePosition(body, 0.1);
    expect(body.position.y).toBeCloseTo(-0.1, 6);
  });

  it('leaves a static body alone', () => {
    const body = createBody({ id: 'a', type: 'static', colliders: [collider(sphere(1))] });
    integrateVelocity(body, new THREE.Vector3(0, -10, 0), 1);
    integratePosition(body, 1);
    expect(body.position.y).toBe(0);
  });

  it('keeps the orientation quaternion normalised while spinning', () => {
    const body = createBody({ id: 'a', mass: 1, colliders: [collider(box(1, 1, 1))], angularDamping: 0 });
    body.angularVelocity.set(0, 6, 0);
    for (let step = 0; step < 200; step += 1) integratePosition(body, 1 / 60);
    expect(body.quaternion.length()).toBeCloseTo(1, 9);
  });
});

describe('updateSleep', () => {
  it('sleeps a body that has been still for long enough, and zeroes what is left', () => {
    const body = createBody({ id: 'a', mass: 1, colliders: [collider(sphere(0.5))] });
    body.linearVelocity.set(0.01, 0, 0);
    for (let step = 0; step < 100; step += 1) updateSleep(body, SLEEP_DELAY / 10);
    expect(body.sleeping).toBe(true);
    expect(body.linearVelocity.length()).toBe(0);
  });

  it('never sleeps a body that asked not to', () => {
    const body = createBody({ id: 'a', mass: 1, colliders: [collider(sphere(0.5))], neverSleep: true });
    for (let step = 0; step < 100; step += 1) updateSleep(body, 0.1);
    expect(body.sleeping).toBe(false);
  });

  it('wakes again as soon as something moves it', () => {
    const body = createBody({ id: 'a', mass: 1, colliders: [collider(sphere(0.5))] });
    for (let step = 0; step < 100; step += 1) updateSleep(body, 0.1);
    body.linearVelocity.set(3, 0, 0);
    updateSleep(body, 0.1);
    expect(body.sleeping).toBe(false);
  });
});

describe('setBodyDynamic', () => {
  it('gives a static body mass and inertia in place, keeping its pose', () => {
    const body = createBody({
      id: 'post',
      type: 'static',
      colliders: [collider(box(0.1, 2, 0.1), new THREE.Vector3(0, 2, 0))],
      position: new THREE.Vector3(5, 0, -3),
    });
    setBodyDynamic(body, 90);
    expect(body.type).toBe('dynamic');
    expect(body.invMass).toBeCloseTo(1 / 90, 9);
    expect(body.invInertiaLocal.x).toBeGreaterThan(0);
    expect(body.position.x).toBe(5);
  });

  it('is a no-op on a body that is already dynamic', () => {
    const body = createBody({ id: 'a', mass: 3, colliders: [collider(sphere(1))] });
    setBodyDynamic(body, 500);
    expect(body.mass).toBe(3);
  });
});
