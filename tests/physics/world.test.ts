import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createPhysicsWorld } from '../../src/physics/world';
import { createBody } from '../../src/physics/rigidBody';
import { box, collider, sphere } from '../../src/physics/types';

function settle(world: ReturnType<typeof createPhysicsWorld>, seconds: number): void {
  const dt = 1 / 60;
  for (let step = 0; step < Math.round(seconds / dt); step += 1) world.step(dt);
}

describe('ground', () => {
  it('drops a body onto flat ground and holds it there', () => {
    const world = createPhysicsWorld();
    const ball = createBody({
      id: 'ball',
      mass: 5,
      colliders: [collider(sphere(0.5))],
      position: new THREE.Vector3(0, 4, 0),
    });
    world.addBody(ball);
    settle(world, 3);
    expect(ball.position.y).toBeGreaterThan(0.45);
    expect(ball.position.y).toBeLessThan(0.56);
  });

  it('rests a box on raised terrain rather than on y=0', () => {
    const world = createPhysicsWorld();
    world.setGroundHeight((x) => (x > 5 ? 3 : 0));
    const crate = createBody({
      id: 'crate',
      mass: 20,
      colliders: [collider(box(0.5, 0.5, 0.5), new THREE.Vector3(0, 0.5, 0))],
      position: new THREE.Vector3(9, 6, 0),
    });
    world.addBody(crate);
    settle(world, 4);
    expect(crate.position.y).toBeGreaterThan(2.9);
    expect(crate.position.y).toBeLessThan(3.1);
  });

  it('lets a resting body fall asleep so it stops being solved', () => {
    const world = createPhysicsWorld();
    const ball = createBody({
      id: 'ball',
      mass: 5,
      colliders: [collider(sphere(0.5))],
      position: new THREE.Vector3(0, 1, 0),
    });
    world.addBody(ball);
    settle(world, 6);
    expect(ball.sleeping).toBe(true);
  });
});

describe('raycast', () => {
  it('casts below an overhead deck without a zero-distance phantom hit', () => {
    const world = createPhysicsWorld();
    world.setGroundHeight((_x, _z, maxY = Infinity) => maxY >= 5 ? 5 : 0);
    expect(world.raycast(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), 2)!.distance).toBeCloseTo(1);
    expect(world.raycast(new THREE.Vector3(0, 6, 0), new THREE.Vector3(0, -1, 0), 2)!.distance).toBeCloseTo(1);
  });

  it('keeps dynamic bodies on their own level at stacked road surfaces', () => {
    const world = createPhysicsWorld();
    world.setGroundHeight((_x, _z, maxY = Infinity) => maxY >= 5 ? 5 : 0);
    const bodies = [0.5, 5.5].map((y, i) => createBody({
      id: `level-${i}`, mass: 5, position: new THREE.Vector3(0, y, 0),
      colliders: [collider(sphere(0.5))],
    }));
    bodies.forEach(body => world.addBody(body));
    settle(world, 2);
    expect(bodies[0].position.y).toBeCloseTo(0.5, 1);
    expect(bodies[1].position.y).toBeCloseTo(5.5, 1);
  });

  it('finds flat ground straight below', () => {
    const world = createPhysicsWorld();
    const hit = world.raycast(new THREE.Vector3(3, 5, -2), new THREE.Vector3(0, -1, 0), 10);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(5, 2);
    expect(hit!.normal.y).toBeCloseTo(1, 3);
  });

  it('follows a slope, and reports its normal leaning with it', () => {
    const world = createPhysicsWorld();
    world.setGroundHeight((x) => x * 0.5);
    const hit = world.raycast(new THREE.Vector3(4, 10, 0), new THREE.Vector3(0, -1, 0), 20);
    expect(hit!.distance).toBeCloseTo(8, 2);
    expect(hit!.normal.x).toBeLessThan(0);
  });

  it('prefers a body over the ground behind it', () => {
    const world = createPhysicsWorld();
    const slab = createBody({
      id: 'slab',
      type: 'static',
      colliders: [collider(box(2, 0.25, 2))],
      position: new THREE.Vector3(0, 2, 0),
    });
    world.addBody(slab);
    const hit = world.raycast(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), 10);
    expect(hit!.body.id).toBe('slab');
    expect(hit!.distance).toBeCloseTo(2.75, 5);
  });

  it('skips the body it was told to ignore', () => {
    const world = createPhysicsWorld();
    const slab = createBody({
      id: 'slab',
      type: 'static',
      colliders: [collider(box(2, 0.25, 2))],
      position: new THREE.Vector3(0, 2, 0),
    });
    world.addBody(slab);
    const hit = world.raycast(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), 10, slab);
    expect(hit!.body.id).toBe('physics:ground');
  });

  it('returns nothing when the ray stops short of everything', () => {
    const world = createPhysicsWorld();
    expect(world.raycast(new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, -1, 0), 5)).toBeNull();
  });
});

/** A lamp-post-shaped static prop with a known anchor strength. */
function anchoredPost(anchorImpulse: number) {
  return createBody({
    id: 'post',
    type: 'static',
    colliders: [collider(box(0.1, 2.3, 0.1), new THREE.Vector3(0, 2.3, 0))],
    position: new THREE.Vector3(0, 0, 0),
    userData: { layer: 'props', propId: 'post', mass: 90, anchorImpulse },
  });
}

/** A car-shaped body driven at the post at `speed`. */
function striker(speed: number) {
  const body = createBody({
    id: 'car',
    mass: 1250,
    colliders: [collider(box(1, 0.6, 2), new THREE.Vector3(0, 0.8, 0))],
    position: new THREE.Vector3(0, 0, -2.1),
    neverSleep: true,
  });
  body.linearVelocity.set(0, 0, speed);
  return body;
}

describe('dislodging anchored props', () => {
  it('leaves a post standing when the impact is under its anchor', () => {
    const world = createPhysicsWorld();
    const post = anchoredPost(20_000);
    world.addBody(post);
    world.addBody(striker(2));
    settle(world, 0.5);
    expect(post.type).toBe('static');
  });

  it('tears the post loose when the impact exceeds it, and topples it', () => {
    const world = createPhysicsWorld();
    const post = anchoredPost(7_000);
    world.addBody(post);
    const car = striker(12);
    world.addBody(car);
    settle(world, 1.5);
    expect(post.type).toBe('dynamic');
    // Struck low and carrying its mass high, it goes over rather than sliding upright.
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(post.quaternion).y).toBeLessThan(0.9);
  });

  it('announces each prop it dislodges exactly once', () => {
    const world = createPhysicsWorld();
    const listener = vi.fn();
    world.onDislodge(listener);
    world.addBody(anchoredPost(7_000));
    world.addBody(striker(12));
    settle(world, 1.5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].id).toBe('post');
  });

  it('ignores a body merely resting against the prop', () => {
    const world = createPhysicsWorld();
    const post = anchoredPost(7_000);
    world.addBody(post);
    const leaning = createBody({
      id: 'crate',
      mass: 4_000,
      colliders: [collider(box(1, 0.6, 1), new THREE.Vector3(0, 0.6, 0))],
      position: new THREE.Vector3(0, 0, -1.05),
    });
    world.addBody(leaning);
    settle(world, 1);
    expect(post.type).toBe('static');
  });
});

describe('removeLayer', () => {
  it('drops every body tagged with that layer and leaves the rest', () => {
    const world = createPhysicsWorld();
    world.addBody(anchoredPost(1_000));
    const car = striker(0);
    world.addBody(car);
    expect(world.bodies()).toHaveLength(2);
    world.removeLayer('props');
    expect(world.bodies()).toHaveLength(1);
    expect(world.bodies()[0].id).toBe('car');
  });
});

describe('swept collision', () => {
  /** A lamp-post-shaped static prop, thin enough that a boosted car's per-tick motion
   * (200 m/s / 60 Hz ≈ 3.3m) clears it completely between two discrete positions. */
  function lampPost(z: number) {
    return createBody({
      id: 'lamp',
      type: 'static',
      colliders: [collider(box(0.1, 2.3, 0.1), new THREE.Vector3(0, 2.3, 0))],
      position: new THREE.Vector3(0, 0, z),
      userData: { layer: 'props', propId: 'lamp', mass: 90, anchorImpulse: 1e9 },
    });
  }

  function car(speed: number) {
    const body = createBody({
      id: 'car',
      mass: 1250,
      colliders: [collider(box(1, 0.6, 2), new THREE.Vector3(0, 0.8, 0))],
      position: new THREE.Vector3(0, 0, 0),
      neverSleep: true,
      userData: { kind: 'car' },
    });
    body.linearVelocity.set(0, 0, speed);
    return body;
  }

  it('catches a boosted car crossing a thin post within one tick', () => {
    const world = createPhysicsWorld();
    world.addBody(lampPost(5));
    const striker = car(200);
    world.addBody(striker);

    // Discrete AABBs never overlap at tick start: the car's front face (z=2) is 2.9m
    // short of the post (z=4.9) and would clear it entirely in this one 3.3m step.
    world.step(1 / 60);

    expect(world.manifolds().some((m) => m.a.id === 'lamp' || m.b.id === 'lamp')).toBe(true);
    expect(striker.position.z).toBeLessThan(4.9);
  });

  it('leaves an equally fast, untagged body free to tunnel through the same post', () => {
    // Documents the fix's scope: only bodies tagged `kind: 'car'` get the sweep. A stray
    // fast dynamic body without that tag collides exactly as it did before this existed.
    const world = createPhysicsWorld();
    world.addBody(lampPost(5));
    const debris = createBody({
      id: 'debris',
      mass: 50,
      colliders: [collider(box(1, 0.6, 2), new THREE.Vector3(0, 0.8, 0))],
      position: new THREE.Vector3(0, 0, 0),
      neverSleep: true,
    });
    debris.linearVelocity.set(0, 0, 200);
    world.addBody(debris);

    world.step(1 / 60);

    // No sweep, so nothing stops it: it moves by velocity * dt exactly, as if the post
    // were not there.
    expect(world.manifolds().some((m) => m.a.id === 'lamp' || m.b.id === 'lamp')).toBe(false);
    expect(debris.position.z).toBeCloseTo(200 * (1 / 60), 2);
  });
});

describe('sloped ground', () => {
  /** A constant 1-in-5 bank rising with x, which is roughly what a landuse mound's edge
   * is at the default terrain slope. */
  const bank = (world: ReturnType<typeof createPhysicsWorld>) => {
    world.setGroundHeight((x) => x * 0.2);
  };

  it('lets a body slide down a bank instead of parking on it', () => {
    // Solved with a vertical normal, the ground holds a body up with a force that has no
    // component along the slope: nothing ever slides, and the hill is an escalator.
    const world = createPhysicsWorld();
    bank(world);
    const crate = createBody({
      id: 'crate',
      mass: 40,
      colliders: [collider(box(0.5, 0.5, 0.5), new THREE.Vector3(0, 0.5, 0))],
      position: new THREE.Vector3(20, 4.1, 0),
      // Combined with the ground's own 0.95 this is a coefficient of about 0.1, well
      // under the slope's 0.2 gradient, so it has to slide.
      friction: 0.01,
      neverSleep: true,
    });
    world.addBody(crate);
    settle(world, 3);
    expect(crate.position.x).toBeLessThan(19.5);
  });

  it('holds the same body still on the same bank once it has grip', () => {
    const world = createPhysicsWorld();
    bank(world);
    const crate = createBody({
      id: 'crate',
      mass: 40,
      colliders: [collider(box(0.5, 0.5, 0.5), new THREE.Vector3(0, 0.5, 0))],
      position: new THREE.Vector3(20, 4.05, 0),
      friction: 1.1,
      neverSleep: true,
    });
    world.addBody(crate);
    settle(world, 3);
    expect(Math.abs(crate.position.x - 20)).toBeLessThan(0.35);
  });

  it('rests a body on the surface, not sunk into it or floating over it', () => {
    const world = createPhysicsWorld();
    bank(world);
    const ball = createBody({
      id: 'ball',
      mass: 5,
      colliders: [collider(sphere(0.5))],
      position: new THREE.Vector3(-8, 2, 0),
      friction: 1.2,
    });
    world.addBody(ball);
    settle(world, 3);
    const ground = world.groundHeightAt(ball.position.x, ball.position.z);
    // A sphere on a 1-in-5 slope sits a little under a radius above the height directly
    // below it, because it touches along the surface normal rather than straight down.
    expect(ball.position.y - ground).toBeGreaterThan(0.4);
    expect(ball.position.y - ground).toBeLessThan(0.55);
  });

  it('reports a ground normal that leans with the surface', () => {
    const world = createPhysicsWorld();
    bank(world);
    const hit = world.raycast(new THREE.Vector3(10, 20, 0), new THREE.Vector3(0, -1, 0), 40);
    expect(hit).not.toBeNull();
    expect(hit!.normal.x).toBeLessThan(-0.15);
    expect(hit!.normal.y).toBeGreaterThan(0.9);
  });
});
