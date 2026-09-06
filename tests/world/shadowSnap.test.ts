import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { shadowTexelSize, snapShadowTarget } from '../../src/world/shadowSnap';

describe('shadowTexelSize', () => {
  it('is the frustum width divided across the depth texture', () => {
    expect(shadowTexelSize(150, 4096)).toBeCloseTo(300 / 4096, 8);
    expect(shadowTexelSize(105, 2048)).toBeCloseTo(210 / 2048, 8);
  });

  it('is zero for a frustum that cannot be sampled', () => {
    expect(shadowTexelSize(0, 4096)).toBe(0);
    expect(shadowTexelSize(150, 0)).toBe(0);
  });
});

describe('snapShadowTarget', () => {
  const overhead = new THREE.Vector3(0, 320, 0);

  it('lands the target on a texel boundary rather than tracking it exactly', () => {
    const snapped = snapShadowTarget(new THREE.Vector3(10.31, 0, -4.77), overhead, 0.5);
    // Sun overhead: the light's projection plane is world XZ, so the grid is on x and z.
    expect(snapped.x).toBeCloseTo(10.5, 6);
    expect(snapped.z).toBeCloseTo(-5, 6);
  });

  it('holds still while the player moves within one texel, then jumps a whole texel', () => {
    const texel = 0.5;
    const at = (x: number) => snapShadowTarget(new THREE.Vector3(x, 0, 0), overhead, texel).x;

    // The crawl this exists to kill: a frustum that slid by these sub-texel amounts made
    // every surface re-sample slightly differently each frame.
    expect(at(4.0)).toBeCloseTo(at(4.2), 6);
    expect(at(4.0)).toBeCloseTo(at(4.24), 6);
    // ...and when it does move, it moves by exactly one texel.
    expect(at(4.3) - at(4.0)).toBeCloseTo(texel, 6);
  });

  it('quantises the plane the light actually projects onto, not world XZ', () => {
    // A low sun along +x projects across world Z and world Y; snapping x instead would
    // leave the crawl in place on every vertical surface.
    const lowSun = new THREE.Vector3(320, 40, 0);
    const texel = 1;
    const snapped = snapShadowTarget(new THREE.Vector3(7.3, 3.4, 2.6), lowSun, texel);

    // Depth along the light direction is preserved exactly — only the two raster axes move.
    const forward = lowSun.clone().normalize().negate();
    expect(snapped.dot(forward)).toBeCloseTo(new THREE.Vector3(7.3, 3.4, 2.6).dot(forward), 6);
    // And the target really did move, so something was quantised.
    expect(snapped.distanceTo(new THREE.Vector3(7.3, 3.4, 2.6))).toBeGreaterThan(0);
  });

  it('passes the target through untouched when there is nothing to snap to', () => {
    const target = new THREE.Vector3(3.3, 1.2, -8.7);
    expect(snapShadowTarget(target, overhead, 0).equals(target)).toBe(true);
    expect(snapShadowTarget(target, new THREE.Vector3(), 0.5).equals(target)).toBe(true);
  });
});
