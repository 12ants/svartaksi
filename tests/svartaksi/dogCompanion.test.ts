import { describe, expect, it } from 'vitest';

import { createDogState, stepDog } from '../../src/svartaksi/dogCompanion';

const flatGround = () => 0;
const alwaysVisible = () => true;
const neverVisible = () => false;

function distanceBetweenTestHelper(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('dogCompanion', () => {
  it('starts stalking with zero trust at the given position', () => {
    const dog = createDogState(10, 20);
    expect(dog.behavior).toBe('stalking');
    expect(dog.trust).toBe(0);
    expect(dog.x).toBe(10);
    expect(dog.z).toBe(20);
  });

  it('stalking moves away from a nearby player rather than staying put', () => {
    const dog = createDogState(0, 0);
    const stepped = stepDog(
      dog,
      { playerPosition: { x: 1, z: 0 }, playerSpeed: 3, playerFacingDog: true },
      1,
      flatGround,
      alwaysVisible,
    );
    const startDist = Math.hypot(dog.x - 1, dog.z - 0);
    const endDist = Math.hypot(stepped.x - 1, stepped.z - 0);
    expect(endDist).toBeGreaterThan(startDist);
  });

  it('stalking prefers a non-visible retreat candidate over a visible one at similar distance', () => {
    const dog = createDogState(0, 0);
    // isVisible reports false only for the +x direction, so the dog should retreat
    // toward it even though other directions are equally far from the player.
    const preferPlusX = (p: { x: number; z: number }) => !(p.x > dog.x);
    const stepped = stepDog(
      dog,
      { playerPosition: { x: -5, z: 0 }, playerSpeed: 3, playerFacingDog: true },
      1,
      flatGround,
      preferPlusX,
    );
    expect(stepped.x).toBeGreaterThan(dog.x);
  });

  it('follows terrain height every step', () => {
    const dog = createDogState(0, 0);
    const slope = (p: { x: number; z: number }) => p.z * -0.1;
    const stepped = stepDog(
      dog,
      { playerPosition: { x: 5, z: 5 }, playerSpeed: 0, playerFacingDog: false },
      1,
      slope,
      neverVisible,
    );
    expect(stepped.y).toBeCloseTo(slope({ x: stepped.x, z: stepped.z }), 6);
  });

  it('is deterministic: same state and input produce the same result', () => {
    const dog = createDogState(3, 4, 0.2);
    const input = { playerPosition: { x: 1, z: 1 }, playerSpeed: 2, playerFacingDog: true };
    const a = stepDog(dog, input, 0.25, flatGround, alwaysVisible);
    const b = stepDog(dog, input, 0.25, flatGround, alwaysVisible);
    expect(a).toEqual(b);
  });

  const AWARENESS_RANGE_METERS = 12; // must match dogCompanion.ts's constant

  function stillNearby(dog: ReturnType<typeof createDogState>) {
    return {
      playerPosition: { x: dog.x + 2, z: dog.z },
      playerSpeed: 0,
      playerFacingDog: false,
    };
  }

  function chasingDirectly(dog: ReturnType<typeof createDogState>) {
    return {
      playerPosition: { x: dog.x + 2, z: dog.z },
      playerSpeed: 6,
      playerFacingDog: true,
    };
  }

  it('trust rises when the player is near and still or facing away', () => {
    let dog = createDogState(0, 0);
    dog = stepDog(dog, stillNearby(dog), 1, flatGround, alwaysVisible);
    expect(dog.trust).toBeGreaterThan(0);
  });

  it('trust falls on a fast, direct approach while still stalking', () => {
    let dog = createDogState(0, 0);
    dog = stepDog(dog, stillNearby(dog), 5, flatGround, alwaysVisible); // build up trust first
    const trustBeforeChase = dog.trust;
    dog = stepDog(dog, chasingDirectly(dog), 1, flatGround, alwaysVisible);
    expect(dog.trust).toBeLessThan(trustBeforeChase);
  });

  it('trust holds when the player is outside the awareness range', () => {
    let dog = createDogState(0, 0);
    const farAway = {
      playerPosition: { x: AWARENESS_RANGE_METERS + 50, z: 0 },
      playerSpeed: 0,
      playerFacingDog: false,
    };
    dog = stepDog(dog, farAway, 1, flatGround, alwaysVisible);
    expect(dog.trust).toBe(0);
  });

  it('advances through every state exactly once as trust accumulates, never skipping a state', () => {
    let dog = createDogState(0, 0);
    const seen: string[] = [dog.behavior];
    for (let i = 0; i < 2000 && dog.behavior !== 'companion'; i += 1) {
      dog = stepDog(dog, stillNearby(dog), 1, flatGround, alwaysVisible);
      if (dog.behavior !== seen[seen.length - 1]) seen.push(dog.behavior);
    }
    expect(seen).toEqual(['stalking', 'wary', 'following', 'companion']);
  });

  it('trust cannot demote the dog out of following once reached, even under a chase', () => {
    let dog = createDogState(0, 0);
    for (let i = 0; i < 2000 && dog.behavior !== 'following'; i += 1) {
      dog = stepDog(dog, stillNearby(dog), 1, flatGround, alwaysVisible);
    }
    expect(dog.behavior).toBe('following');
    for (let i = 0; i < 50; i += 1) {
      dog = stepDog(dog, chasingDirectly(dog), 1, flatGround, alwaysVisible);
    }
    expect(['following', 'companion']).toContain(dog.behavior);
  });

  it('following closes distance toward the player when farther than the leash radius', () => {
    let dog = createDogState(0, 0);
    for (let i = 0; i < 2000 && dog.behavior !== 'following'; i += 1) {
      dog = stepDog(dog, stillNearby(dog), 1, flatGround, alwaysVisible);
    }
    const farPlayer = { playerPosition: { x: dog.x + 20, z: dog.z }, playerSpeed: 1, playerFacingDog: false };
    const before = distanceBetweenTestHelper(dog, farPlayer.playerPosition);
    dog = stepDog(dog, farPlayer, 1, flatGround, alwaysVisible);
    const after = distanceBetweenTestHelper(dog, farPlayer.playerPosition);
    expect(after).toBeLessThan(before);
  });

  it('trust never decreases once the dog reaches following', () => {
    let dog = createDogState(0, 0);
    for (let i = 0; i < 2000 && dog.behavior !== 'following'; i += 1) {
      dog = stepDog(dog, stillNearby(dog), 1, flatGround, alwaysVisible);
    }
    expect(dog.behavior).toBe('following');
    const trustBeforeChase = dog.trust;
    for (let i = 0; i < 50; i += 1) {
      dog = stepDog(dog, chasingDirectly(dog), 1, flatGround, alwaysVisible);
    }
    expect(dog.trust).toBeGreaterThanOrEqual(trustBeforeChase);
  });

  it('trust floors at 0 rather than going negative under a sustained chase', () => {
    let dog = createDogState(0, 0);
    expect(dog.trust).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      dog = stepDog(dog, chasingDirectly(dog), 1, flatGround, alwaysVisible);
    }
    expect(dog.trust).toBeGreaterThanOrEqual(0);
    expect(dog.trust).toBe(0);
  });
});
