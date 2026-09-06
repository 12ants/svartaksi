/**
 * The bonfire and the pills round it, as geometry.
 *
 * Same primitive vocabulary as the car, the bus and the player: capsules and boxes, no
 * imported models. The gang are the player's own capsule seen from outside — opaque
 * where the player's is translucent, because the player's translucency is what says
 * "your stand-in" and these are not that.
 *
 * Nothing here accumulates. `update` is a pure function of the clock and the night
 * factor, the same contract the traffic signals and the neon run under.
 */
import * as THREE from 'three';
import { flameLevel, type CampSeat } from './bonfireCamp';
import { PERSON_BODY_LENGTH, PERSON_RADIUS } from './personModel';

/** How deep a seated pill sinks relative to standing. It is sitting on a log, not
 * hovering: the capsule's lower cap disappears into the ground clutter, which is what
 * sells "sitting" without a single joint anywhere in the model. */
const SEATED_DROP = 0.42;

/** The gang, dark to light. Muted against the player's warm yellow — nobody at this fire
 * is the protagonist, and a second bright capsule in frame reads as a second player. */
const PILL_COLORS = [0x4a5560, 0x6b6357, 0x55606b, 0x7a6f63, 0x5f5a66] as const;

/** Flame colours at the base and the tip. The tip is nearly white at full flicker, which
 * is what stops a cone of flat orange from reading as a traffic cone. */
const FLAME_BASE = 0xff5a1e;
const FLAME_TIP = 0xffd79a;

/** Peak intensity of the one real light at the fire. */
const FIRE_LIGHT_INTENSITY = 26;
/** How far that light reaches. Short: it is a fire in a clearing, not a floodlight, and
 * the falloff is what keeps the trees beyond the ring dark. */
const FIRE_LIGHT_DISTANCE = 22;

export interface BonfireCampModel {
  group: THREE.Group;
  /** The seated pills, in layout order, so the runtime can turn one to face the player
   * without walking the scene graph. */
  pills: THREE.Group[];
  /**
   * Drives the flame and its light. `nightFactor` is the same 0..1 the lamps and the
   * facades are shaded by — the fire burns around the clock, but its *light* only earns
   * its cost after dusk, and at noon a point light this bright washes the clearing out.
   */
  update(time: number, nightFactor: number): void;
  dispose(): void;
}

/**
 * Builds the camp at the origin of its own group. The runtime positions the group; every
 * seat offset in `seats` is relative to the fire, so the whole camp moves as one.
 */
export function createBonfireCamp(seats: CampSeat[]): BonfireCampModel {
  const group = new THREE.Group();
  group.name = 'bonfire-camp';

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(value: T): T => {
    disposables.push(value);
    return value;
  };

  // The fire pit: a ring of stones and a crossed stack of logs. Both are clutter in the
  // literal sense — they exist so the flame has something to come out of, and so the
  // seated pills have a reason to be sunk into the ground at that height.
  const stoneGeometry = track(new THREE.DodecahedronGeometry(0.19, 0));
  const stoneMaterial = track(new THREE.MeshStandardMaterial({ color: 0x6c6a63, roughness: 0.95 }));
  const stones = new THREE.InstancedMesh(stoneGeometry, stoneMaterial, 9);
  stones.name = 'bonfire:stones';
  stones.castShadow = true;
  stones.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < 9; index += 1) {
    // Irregular spacing and size from the index alone — a ring of nine identical stones
    // at forty-degree spacing looks laid out by a machine.
    const angle = (index / 9) * Math.PI * 2 + Math.sin(index * 2.3) * 0.12;
    const radius = 0.92 + Math.sin(index * 4.1) * 0.06;
    const scale = 0.8 + Math.abs(Math.sin(index * 1.7)) * 0.5;
    matrix.makeRotationY(index * 1.1);
    matrix.scale(new THREE.Vector3(scale, scale * 0.7, scale));
    matrix.setPosition(Math.sin(angle) * radius, 0.06, Math.cos(angle) * radius);
    stones.setMatrixAt(index, matrix);
  }
  stones.instanceMatrix.needsUpdate = true;
  group.add(stones);

  const logGeometry = track(new THREE.CylinderGeometry(0.07, 0.085, 0.8, 6));
  const logMaterial = track(new THREE.MeshStandardMaterial({ color: 0x3b2d22, roughness: 0.95 }));
  const logs = new THREE.InstancedMesh(logGeometry, logMaterial, 5);
  logs.name = 'bonfire:logs';
  logs.castShadow = true;
  logs.receiveShadow = true;
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (let index = 0; index < 5; index += 1) {
    // A tepee: each log stood on its end and tipped a little off vertical, leaning into
    // its neighbours round the pit. Tipping from *horizontal* instead (the first
    // attempt) splays them flat across the ground like a compass rose, which reads as
    // five logs dropped in a heap rather than as a fire somebody built.
    euler.set(0.42, (index / 5) * Math.PI * 2, 0, 'YXZ');
    quaternion.setFromEuler(euler);
    matrix.makeRotationFromQuaternion(quaternion);
    matrix.setPosition(0, 0.38, 0);
    logs.setMatrixAt(index, matrix);
  }
  logs.instanceMatrix.needsUpdate = true;
  group.add(logs);

  // The flame is unlit geometry (MeshBasicMaterial) for the same reason a lamp lens is:
  // it is the light source. Two nested cones, the inner one brighter and thinner, so the
  // silhouette has a core rather than being one flat wedge of orange.
  const outerFlame = new THREE.Mesh(
    track(new THREE.ConeGeometry(0.5, 1.35, 7, 1, true)),
    track(new THREE.MeshBasicMaterial({
      color: FLAME_BASE, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false,
    })),
  );
  outerFlame.name = 'bonfire:flame-outer';
  outerFlame.position.y = 0.72;
  group.add(outerFlame);

  const innerFlame = new THREE.Mesh(
    track(new THREE.ConeGeometry(0.24, 0.9, 6, 1, true)),
    track(new THREE.MeshBasicMaterial({
      color: FLAME_TIP, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
    })),
  );
  innerFlame.name = 'bonfire:flame-inner';
  innerFlame.position.y = 0.58;
  group.add(innerFlame);

  // One real light, and the only one in the world besides the phone torch. A fire is the
  // one thing in this city that has to actually light what is around it: the pills at the
  // ring are the only characters the player ever gets close to, and baking their key
  // light into a material colour the way the street lamps do would leave five faces flat
  // in the middle of the one scene that is about faces.
  const fireLight = new THREE.PointLight(FLAME_BASE, 0, FIRE_LIGHT_DISTANCE, 2);
  fireLight.name = 'bonfire:light';
  fireLight.position.y = 0.75;
  // Shadow-casting from a point light is six frustum renders per frame. At a fire ringed
  // by five capsules and a stack of logs there is nothing worth six passes.
  fireLight.castShadow = false;
  group.add(fireLight);

  const pills: THREE.Group[] = [];
  const pillGeometry = track(new THREE.CapsuleGeometry(PERSON_RADIUS, PERSON_BODY_LENGTH, 6, 12));
  seats.forEach((seat, index) => {
    const pill = new THREE.Group();
    pill.name = `bonfire:pill:${index}`;
    const material = track(new THREE.MeshStandardMaterial({
      color: PILL_COLORS[index % PILL_COLORS.length], roughness: 0.72, metalness: 0.02,
    }));
    const body = new THREE.Mesh(pillGeometry, material);
    body.name = `bonfire:pill:${index}:body`;
    body.position.y = PERSON_RADIUS + PERSON_BODY_LENGTH / 2 - SEATED_DROP;
    body.castShadow = true;
    body.receiveShadow = true;
    pill.add(body);
    pill.position.set(seat.offset.x, 0, seat.offset.z);
    pill.rotation.y = seat.yaw;
    // Leaning is applied to the body rather than the group so the group's yaw stays a
    // clean "which way is this pill facing" the runtime can read and write.
    body.rotation.x = seat.lean;
    group.add(pill);
    pills.push(pill);
  });

  const baseColor = new THREE.Color(FLAME_BASE);
  const tipColor = new THREE.Color(FLAME_TIP);
  const outerMaterial = outerFlame.material as THREE.MeshBasicMaterial;
  const innerMaterial = innerFlame.material as THREE.MeshBasicMaterial;

  return {
    group,
    pills,
    update(time, nightFactor) {
      const level = flameLevel(time);
      // Height and width flicker out of phase with each other, so the flame breathes
      // rather than pulsing as one solid shape.
      outerFlame.scale.set(0.9 + level * 0.2, level, 0.9 + level * 0.2);
      innerFlame.scale.set(0.85 + level * 0.3, 0.8 + level * 0.35, 0.85 + level * 0.3);
      // Both cones turn, at different rates and in opposite directions. A cone is a hard
      // seven-sided silhouette and holding it still is what gives away that the fire is
      // two pieces of geometry; turning it keeps a new edge toward the camera.
      outerFlame.rotation.y = time * 0.9;
      innerFlame.rotation.y = -time * 1.4;
      outerMaterial.color.copy(baseColor).lerp(tipColor, (level - 0.55) * 0.6);
      innerMaterial.opacity = 0.72 + level * 0.22;
      const night = Math.min(1, Math.max(0, nightFactor));
      fireLight.intensity = FIRE_LIGHT_INTENSITY * level * night;
      // A light at intensity 0 is still a light the renderer uploads uniforms for and
      // tests every material against; switching it off entirely by day is the whole
      // point of gating it on the night factor.
      fireLight.visible = fireLight.intensity > 0.01;
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
      stones.dispose();
      logs.dispose();
    },
  };
}
