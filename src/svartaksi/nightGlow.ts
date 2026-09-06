/**
 * A faint self-lit rim on the things the player is meant to keep track of — the car, the
 * bus and the player pill — once the sun is down.
 *
 * At night the streets are lit only by SceneLighting.nightFill, a flat view-independent
 * stand-in for street lighting (this renderer has no real lamp lights). That keeps the
 * city readable but leaves a dark red car on dark asphalt with almost nothing separating
 * them. Rather than adding real lights, each surface lifts its own colour slightly: it
 * stays the object's own hue, so a red bus glows red and reads as itself rather than as a
 * lamp, and it costs nothing beyond an emissive term the material already supports.
 *
 * Anything that already had an emissive — the bus headlight lenses, its destination
 * display — is left alone: those are meant to be light sources and are already tuned.
 */
import * as THREE from 'three';

/** Peak emissive at full night. Deliberately low: this is separation, not illumination. */
export const NIGHT_GLOW_INTENSITY = 0.34;

/**
 * Collects the materials under `root` that should glow, and primes each one's emissive
 * colour from its own albedo. Returns them so a caller can drive them per frame without
 * re-traversing the tree.
 */
export function collectNightGlowMaterials(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const materials = new Set<THREE.MeshStandardMaterial>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      // Already emits on its own terms — a headlight lens, a lit display.
      if (material.emissive.getHex() !== 0) continue;
      if (materials.has(material)) continue;
      material.emissive.copy(material.color);
      material.emissiveIntensity = 0;
      materials.add(material);
    }
  });
  return [...materials];
}

/** Drives the collected materials from the scene's 0..1 night factor. */
export function applyNightGlow(
  materials: THREE.MeshStandardMaterial[],
  nightFactor: number,
  strength = NIGHT_GLOW_INTENSITY,
): void {
  const intensity = Math.max(0, Math.min(1, nightFactor)) * strength;
  for (const material of materials) material.emissiveIntensity = intensity;
}
