/**
 * Keeps the directional shadow frustum on a fixed grid as it follows the player.
 *
 * The sun's shadow camera is parked relative to whatever the player currently is, so it
 * travels with them. Moved by an arbitrary sub-texel amount each frame, the shadow map's
 * texel grid slides continuously across the world, and every surface it lands on
 * re-samples slightly differently from one frame to the next. What that looks like is the
 * classic crawl: bands of self-shadow acne that ripple along walls and roadway as you
 * drive, worst on large flat surfaces at a shallow angle to the sun — exactly where a
 * static shadow map would look clean.
 *
 * Snapping the frustum's centre to whole shadow-map texels makes the grid world-stable:
 * it jumps a texel at a time instead of sliding, and the sampling pattern on any given
 * surface stops changing between frames. The snap happens in the light's own projection
 * plane, not in world XZ — the two only coincide when the sun is directly overhead, and
 * quantising the wrong axes leaves most of the crawl in place.
 */
import * as THREE from 'three';

/** World size of one shadow-map texel, for an orthographic frustum of half-width
 * `extent` rendered into a `mapSize`-square depth texture. */
export function shadowTexelSize(extent: number, mapSize: number): number {
  if (!(extent > 0) || !(mapSize > 0)) return 0;
  return (extent * 2) / mapSize;
}

const right = new THREE.Vector3();
const up = new THREE.Vector3();
const forward = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

/**
 * Rounds `target` onto the shadow map's texel grid, in the plane the light projects onto.
 *
 * `sunOffset` is the light's position relative to its target (the same vector the runtime
 * uses to park the sun). Depth along the light direction is left untouched — only the two
 * axes the shadow map is rasterised across are quantised. A texel size of 0 (shadows off,
 * or a degenerate frustum) returns the target unchanged.
 */
export function snapShadowTarget(
  target: THREE.Vector3,
  sunOffset: THREE.Vector3,
  texelSize: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  if (!(texelSize > 0) || sunOffset.lengthSq() === 0) return out.copy(target);

  forward.copy(sunOffset).normalize().negate();
  // Any up vector works as long as it is not parallel to the light direction, which it
  // is exactly when the sun is straight overhead — the one case worth guarding.
  const reference = Math.abs(forward.dot(WORLD_UP)) > 0.999 ? FALLBACK_UP : WORLD_UP;
  right.crossVectors(forward, reference).normalize();
  up.crossVectors(right, forward).normalize();

  const alongRight = Math.round(target.dot(right) / texelSize) * texelSize;
  const alongUp = Math.round(target.dot(up) / texelSize) * texelSize;
  const alongForward = target.dot(forward);

  return out.set(0, 0, 0)
    .addScaledVector(right, alongRight)
    .addScaledVector(up, alongUp)
    .addScaledVector(forward, alongForward);
}
