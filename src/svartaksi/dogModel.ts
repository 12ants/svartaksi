/**
 * The dog companion's placeholder body: an abstract silhouette in the same primitive
 * register as personModel.ts's player capsule — a body capsule, a head, a tail, no fur
 * or walk-cycle animation. Good enough to read as "a dog" from the chase camera; a more
 * faithful model is explicitly out of scope for wiring the behavior model in
 * (see docs/superpowers/specs/2026-08-06-dog-companion-wiring-design.md).
 */
import * as THREE from 'three';

/** Half-length of the body capsule, nose to tail base. */
export const DOG_BODY_LENGTH = 0.5;
export const DOG_BODY_RADIUS = 0.18;
/** Group origin sits at the dog's feet, same convention as personModel.ts, so
 * position.y is simply whatever surface it is standing on. */
export const DOG_BODY_CENTER_Y = DOG_BODY_RADIUS + 0.05;
const DOG_HEAD_RADIUS = 0.14;
const DOG_TAIL_LENGTH = 0.32;
const DOG_TAIL_RADIUS = 0.035;

export interface DogModel {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
}

export function createDogModel(): DogModel {
  const group = new THREE.Group();
  group.name = 'dog';

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a6a4a, roughness: 0.75, metalness: 0.0,
  });

  // The body capsule lies on its side (rotated onto the Z axis) rather than standing
  // upright like the player's pill — a dog's spine runs horizontal, nose-to-tail.
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(DOG_BODY_RADIUS, DOG_BODY_LENGTH, 4, 10),
    bodyMaterial,
  );
  body.name = 'dog:body';
  body.rotation.x = Math.PI / 2;
  body.position.y = DOG_BODY_CENTER_Y;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(DOG_HEAD_RADIUS, 10, 8), bodyMaterial);
  head.name = 'dog:head';
  // +Z is forward (world's sin/cos heading convention, matching bonfireCamp.ts and
  // dogCompanion.ts's own headingTo): the head sits at the front of the body capsule.
  head.position.set(0, DOG_BODY_CENTER_Y + 0.02, DOG_BODY_LENGTH / 2 + DOG_BODY_RADIUS * 0.6);
  head.castShadow = true;
  group.add(head);

  const tail = new THREE.Mesh(
    new THREE.CylinderGeometry(DOG_TAIL_RADIUS, DOG_TAIL_RADIUS * 0.4, DOG_TAIL_LENGTH, 6),
    bodyMaterial,
  );
  tail.name = 'dog:tail';
  // Angled up and back rather than a limp cylinder — a static "alert" pose since there
  // is no animation this pass.
  tail.position.set(0, DOG_BODY_CENTER_Y + 0.08, -(DOG_BODY_LENGTH / 2 + DOG_BODY_RADIUS * 0.3));
  tail.rotation.x = Math.PI / 3;
  tail.castShadow = true;
  group.add(tail);

  return { group, materials: [bodyMaterial] };
}
