import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { solveContacts, tangentBasis } from '../../src/physics/solver';
import { createBroadphase } from '../../src/physics/broadphase';
import { collideBodies, type Manifold } from '../../src/physics/collision';
import { createBody } from '../../src/physics/rigidBody';
import { box, collider, sphere } from '../../src/physics/types';

function pair(aPosition: THREE.Vector3, bPosition: THREE.Vector3, staticA = false) {
  const a = createBody({
    id: 'a',
    type: staticA ? 'static' : 'dynamic',
    mass: 10,
    colliders: [collider(box(1, 1, 1))],
    position: aPosition,
    restitution: 0,
  });
  const b = createBody({
    id: 'b',
    mass: 10,
    colliders: [collider(box(1, 1, 1))],
    position: bPosition,
    restitution: 0,
  });
  const manifolds: Manifold[] = [];
  collideBodies(a, b, manifolds);
  return { a, b, manifolds };
}

describe('solveContacts', () => {
  it('cancels the closing velocity of two bodies driven together', () => {
    const { a, b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.9, 0, 0));
    a.linearVelocity.set(4, 0, 0);
    b.linearVelocity.set(-4, 0, 0);
    solveContacts(manifolds, 1 / 60);
    expect(b.linearVelocity.x - a.linearVelocity.x).toBeGreaterThan(-0.2);
  });

  it('never pulls separating bodies back together', () => {
    const { a, b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.9, 0, 0));
    a.linearVelocity.set(-3, 0, 0);
    b.linearVelocity.set(3, 0, 0);
    solveContacts(manifolds, 1 / 60);
    // The overlap correction may slow them, but they must still be moving apart.
    expect(b.linearVelocity.x).toBeGreaterThan(0);
    expect(a.linearVelocity.x).toBeLessThan(0);
  });

  it('bounces bodies apart when they are given restitution', () => {
    const a = createBody({
      id: 'a', type: 'static', colliders: [collider(box(1, 1, 1))], restitution: 0.8,
    });
    const b = createBody({
      id: 'b',
      mass: 5,
      colliders: [collider(sphere(0.5))],
      position: new THREE.Vector3(0, 1.45, 0),
      restitution: 0.8,
    });
    b.linearVelocity.set(0, -6, 0);
    const manifolds: Manifold[] = [];
    collideBodies(a, b, manifolds);
    solveContacts(manifolds, 1 / 60);
    expect(b.linearVelocity.y).toBeGreaterThan(3);
  });

  it('leaves an infinitely heavy body alone and moves only the other', () => {
    const { a, b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.9, 0, 0), true);
    b.linearVelocity.set(-5, 0, 0);
    solveContacts(manifolds, 1 / 60);
    expect(a.linearVelocity.length()).toBe(0);
    expect(b.linearVelocity.x).toBeGreaterThan(-0.5);
  });

  it('pushes overlapping bodies apart even when neither is moving', () => {
    const { b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.5, 0, 0), true);
    solveContacts(manifolds, 1 / 60);
    expect(b.linearVelocity.x).toBeGreaterThan(0);
  });

  it('leaves a barely-touching pair alone rather than jittering it apart', () => {
    const { b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.997, 0, 0), true);
    solveContacts(manifolds, 1 / 60);
    // Inside the solver's slop, so no correction impulse at all.
    expect(b.linearVelocity.length()).toBeCloseTo(0, 6);
  });

  it('wakes a sleeping body it is asked to solve', () => {
    const { b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.5, 0, 0), true);
    b.sleeping = true;
    solveContacts(manifolds, 1 / 60);
    expect(b.sleeping).toBe(false);
  });

  it('resists sliding along the contact with friction', () => {
    const a = createBody({
      id: 'a', type: 'static', colliders: [collider(box(4, 1, 4))], friction: 1,
    });
    const b = createBody({
      id: 'b',
      mass: 10,
      colliders: [collider(box(0.5, 0.5, 0.5))],
      position: new THREE.Vector3(0, 1.45, 0),
      friction: 1,
      restitution: 0,
    });
    b.linearVelocity.set(2, -1, 0);
    const manifolds: Manifold[] = [];
    collideBodies(a, b, manifolds);
    solveContacts(manifolds, 1 / 60);
    expect(b.linearVelocity.x).toBeLessThan(2);
  });
});

describe('solveContacts warm start', () => {
  /** A box resting on static ground with one tick's worth of gravity pulling it in —
   * the steady-state case warm starting exists for. Fresh bodies/manifold each call so
   * every run starts from the identical un-solved condition. */
  function restingBox() {
    const ground = createBody({
      id: 'ground', type: 'static', colliders: [collider(box(10, 1, 10))],
    });
    const box2 = createBody({
      id: 'box',
      mass: 10,
      colliders: [collider(box(0.5, 0.5, 0.5))],
      position: new THREE.Vector3(0, 1.49, 0),
      restitution: 0,
    });
    box2.linearVelocity.set(0, -0.16, 0);
    const manifolds: Manifold[] = [];
    collideBodies(ground, box2, manifolds);
    return { box: box2, manifolds };
  }

  it('reaches near the fully-converged velocity in far fewer iterations when warm started', () => {
    // Convergence is judged by the body's resulting velocity, not any single contact
    // point's impulse: the manifold is a 4-point patch and the warm-start seed applies one
    // pair-level value to all of them, so individual points redistribute over the first
    // iteration or two even though the body as a whole is already near equilibrium.
    const converged = restingBox();
    const warmStart = solveContacts(converged.manifolds, 1 / 60, 8);
    const target = converged.box.angularVelocity.length();

    const cold = restingBox();
    solveContacts(cold.manifolds, 1 / 60, 2);
    const coldGap = Math.abs(cold.box.angularVelocity.length() - target);

    const warmed = restingBox();
    solveContacts(warmed.manifolds, 1 / 60, 2, warmStart);
    const warmedGap = Math.abs(warmed.box.angularVelocity.length() - target);

    expect(warmedGap).toBeLessThan(coldGap);
  });

  it('still resolves correctly when a stale seed no longer fits the contact', () => {
    // A body that was resting hard (large seeded impulse) but has since moved to barely
    // touch: the stale seed must not leave it flying rather than settled.
    const { b, manifolds } = pair(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.997, 0, 0), true);
    const stale = new Map([['a:b', 50]]);
    solveContacts(manifolds, 1 / 60, 8, stale);
    expect(b.linearVelocity.length()).toBeLessThan(1);
  });

  it('does not carry a seed forward for a pair with no manifold this tick', () => {
    const seeded = solveContacts([], 1 / 60, 8, new Map([['a:b', 500]]));
    expect(seeded.size).toBe(0);
  });
});

describe('tangentBasis', () => {
  it('returns two unit vectors perpendicular to the normal and to each other', () => {
    for (const normal of [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0.3, 0.4, 0.86).normalize(),
    ]) {
      const t1 = new THREE.Vector3();
      const t2 = new THREE.Vector3();
      tangentBasis(normal, t1, t2);
      expect(t1.length()).toBeCloseTo(1, 6);
      expect(t2.length()).toBeCloseTo(1, 6);
      expect(t1.dot(normal)).toBeCloseTo(0, 6);
      expect(t2.dot(normal)).toBeCloseTo(0, 6);
      expect(t1.dot(t2)).toBeCloseTo(0, 6);
    }
  });
});

describe('broadphase', () => {
  const at = (id: string, x: number, z: number) => createBody({
    id,
    colliders: [collider(box(0.5, 0.5, 0.5))],
    position: new THREE.Vector3(x, 0, z),
  });

  it('pairs movers with the static bodies near them and not with distant ones', () => {
    const broadphase = createBroadphase(4);
    const near = at('near', 1, 0);
    const far = at('far', 500, 0);
    broadphase.setStatic([near, far]);
    const pairs = broadphase.pairs([at('mover', 0, 0)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].b.id).toBe('near');
  });

  it('pairs movers with each other', () => {
    const broadphase = createBroadphase(4);
    broadphase.setStatic([]);
    expect(broadphase.pairs([at('one', 0, 0), at('two', 0.5, 0)])).toHaveLength(1);
    expect(broadphase.pairs([at('one', 0, 0), at('two', 40, 0)])).toHaveLength(0);
  });

  it('reports a straddling static body once, not once per cell it occupies', () => {
    const broadphase = createBroadphase(1);
    const wide = createBody({
      id: 'wide',
      colliders: [collider(box(6, 0.5, 6))],
    });
    broadphase.setStatic([wide]);
    expect(broadphase.pairs([at('mover', 0, 0)])).toHaveLength(1);
  });

  it('forgets the previous static set when it is replaced', () => {
    const broadphase = createBroadphase(4);
    broadphase.setStatic([at('old', 0, 0)]);
    broadphase.setStatic([at('new', 0, 0)]);
    const pairs = broadphase.pairs([at('mover', 0, 0)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].b.id).toBe('new');
  });
});
