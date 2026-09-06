import { describe, expect, it } from 'vitest';
import {
  benchColliders,
  busStopColliders,
  mailboxColliders,
  propProfile,
  streetLightColliders,
  trafficSignalColliders,
  treeColliders,
} from '../../src/world/propProfiles';

/** Momentum a 1250kg car carries at `speed`, which is what anchor strengths are read
 * against — see the calibration note in propProfiles.ts. */
function carImpulseAt(speed: number): number {
  return 1250 * speed;
}

describe('propProfile', () => {
  it('scales mass with the object\'s own size', () => {
    const small = propProfile('tree', treeColliders(7));
    const large = propProfile('tree', treeColliders(19));
    expect(large.mass).toBeGreaterThan(small.mass * 4);
  });

  it('gives a mature tree a plausible mass', () => {
    const mass = propProfile('tree', treeColliders(15)).mass;
    expect(mass).toBeGreaterThan(300);
    expect(mass).toBeLessThan(1_500);
  });

  it('never returns a zero or negative mass', () => {
    expect(propProfile('small-furniture', []).mass).toBeGreaterThan(0);
  });
});

describe('anchor strengths', () => {
  it('lets a car at town speed take out a lamp post but not a mature pine', () => {
    const lamp = propProfile('street-light', streetLightColliders());
    const pine = propProfile('tree', treeColliders(17));
    expect(carImpulseAt(9)).toBeGreaterThan(lamp.anchorImpulse);
    expect(carImpulseAt(9)).toBeLessThan(pine.anchorImpulse);
  });

  it('holds a sapling down at walking pace despite it weighing very little', () => {
    const sapling = propProfile('tree', treeColliders(5));
    // The floor is what stops a light object being torn out by a nudge; without it this
    // would come loose at well under a metre per second.
    expect(sapling.anchorImpulse).toBeGreaterThan(carImpulseAt(3));
  });

  it('orders the street furniture the way their fixings do', () => {
    const bench = propProfile('bench', benchColliders());
    const mailbox = propProfile('mailbox', mailboxColliders());
    const signal = propProfile('traffic-signal', trafficSignalColliders());
    const shelter = propProfile('bus-stop', busStopColliders());
    expect(bench.anchorImpulse).toBeLessThan(mailbox.anchorImpulse);
    expect(mailbox.anchorImpulse).toBeLessThan(signal.anchorImpulse);
    expect(signal.anchorImpulse).toBeLessThan(shelter.anchorImpulse);
  });

  it('lets a walking person shift a bench but nothing bolted down', () => {
    const person = 80 * 6.4;
    expect(person).toBeLessThan(propProfile('mailbox', mailboxColliders()).anchorImpulse);
    expect(person).toBeLessThan(propProfile('street-light', streetLightColliders()).anchorImpulse);
  });
});

describe('collision frames', () => {
  it('stands every prop on the ground rather than through it', () => {
    const frames = [
      treeColliders(12),
      streetLightColliders(),
      trafficSignalColliders(),
      mailboxColliders(),
      busStopColliders(),
      benchColliders(),
    ];
    for (const colliders of frames) {
      for (const item of colliders) {
        const half = item.shape.kind === 'box' ? item.shape.halfExtents.y : item.shape.radius;
        expect(item.offset.y - half).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('puts a traffic signal\'s housing high on its pole, where its mass belongs', () => {
    const [pole, housing] = trafficSignalColliders();
    expect(housing.offset.y).toBeGreaterThan(pole.offset.y);
    expect(housing.shape.kind === 'box' && housing.shape.halfExtents.x)
      .toBeGreaterThan(pole.shape.kind === 'box' ? pole.shape.halfExtents.x : 0);
  });

  it('models a tree as a trunk with the canopy\'s mass above it', () => {
    const [trunk, crown] = treeColliders(20);
    expect(crown.offset.y).toBeGreaterThan(trunk.offset.y);
    // The crown collider is the trunk continuing, not the silhouette: modelling the
    // canopy at its drawn width would make a spruce weigh twenty tonnes.
    expect(crown.shape.kind === 'box' && crown.shape.halfExtents.x).toBeLessThan(0.3);
  });
});
