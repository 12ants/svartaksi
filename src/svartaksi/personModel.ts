/**
 * The player's on-foot avatar: a capsule, deliberately abstract, in the same primitive
 * style as the car and bus. Split out of svartaksiRuntime for the same reason carModel and
 * busModel were — the geometry is inert setup, and the dimensions below are read by the
 * camera rigs and the alight/boarding code as well as by the mesh itself.
 *
 * The visor band is the only asymmetry, and it exists so the pill's facing is readable
 * from the chase camera: a bare capsule gives no cue at all about which way it is about
 * to walk.
 */
import * as THREE from 'three';

export const PERSON_RADIUS = 0.32;
export const PERSON_BODY_LENGTH = 1.02;
/** Offset of the capsule mesh inside the group. The group's own origin is at the pill's
 * feet, so its position.y is simply whatever surface it is standing on. */
export const PERSON_CENTER_Y = PERSON_RADIUS + PERSON_BODY_LENGTH / 2;
export const PERSON_EYE_Y = 1.42;
/** The pill stays a little see-through for good: it is the player's stand-in rather than
 * a citizen, and the translucency is what says so. */
export const PERSON_OPACITY = 0.4;

export interface PersonModel {
  group: THREE.Group;
  /** Both fade together; the runtime drives their opacity on every appearance. */
  materials: THREE.MeshStandardMaterial[];
}

export function createPersonModel(): PersonModel {
  const group = new THREE.Group();
  group.name = 'person';
  // Both start fully invisible: every appearance the pill makes is a fade-in, and
  // opacity 0 is the only state it should ever be first drawn at.
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xf2b544, roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0,
  });
  const visorMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d2529, roughness: 0.4, transparent: true, opacity: 0,
  });

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PERSON_RADIUS, PERSON_BODY_LENGTH, 6, 14),
    bodyMaterial,
  );
  body.name = 'person:body';
  body.position.y = PERSON_CENTER_Y;
  // Starts off, and is switched on by the runtime once the fade-in is far enough along:
  // the shadow map has no notion of opacity, so a caster at opacity 0 would still lay a
  // solid capsule on the ground with nothing visible above it.
  body.castShadow = false;
  body.receiveShadow = true;
  group.add(body);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.1), visorMaterial);
  visor.name = 'person:visor';
  visor.position.set(0, PERSON_EYE_Y - 0.1, PERSON_RADIUS - 0.02);
  group.add(visor);

  return { group, materials: [bodyMaterial, visorMaterial] };
}
