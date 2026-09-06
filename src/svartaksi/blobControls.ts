/**
 * The blob's 'blobby' input scheme, resolved as a pure function of one tick's input.
 *
 * Ported from `docs/misc/blobby/src/components/CharacterController.jsx`, which is in this
 * repo and is the reference this file is checked against. The prototype's shape is kept:
 * a held pointer's offset from the view centre stands in for its `mouse.x`/`mouse.y`, the
 * turn axis orbits the camera on its own yaw (`rotationTarget`), the character's facing is
 * an offset from that yaw (`characterRotationTarget`), and the direction actually walked
 * is the sum of the two.
 *
 * It lives here rather than inline in `svartaksiRuntime.tsx`'s frame loop because that is
 * where the rest of the loop is heading (`cameraRig.ts` and `nearbyPlaces.ts` went the
 * same way) and because control feel is the kind of thing worth pinning with tests: every
 * deviation from the prototype below is deliberate, and a test names each one. The loop
 * keeps what it cannot hand over — collision, ground, jump/crouch/climb, animation — all
 * of which only need the three numbers this returns.
 *
 * Where this deliberately differs from the prototype, and why:
 *
 * - **Movement magnitude is analog, not binary.** The prototype moves at a fixed speed
 *   whenever `movementX !== 0 || movementZ !== 0`, which is right when the only inputs are
 *   keys and a mouse hold. This project also has a touch joystick reporting fractional
 *   axes, and the blob's other scheme already honours them, so a half-deflected stick that
 *   ran at full pace read as a broken stick. Distance from the view centre now sets the
 *   pace too, which is what makes a *walk* reachable with a pointer at all (see below).
 * - **The pointer's auto-run threshold sits past the forward bias.** The prototype ran
 *   whenever either axis passed 0.5 while the mouse was down — but every hold already
 *   carries a 0.4 forward bias, so a barely-upward drag was already a run and the walk band
 *   was effectively unreachable. The threshold now sits out past the bias, so a hold near
 *   the centre walks and only a deliberate reach for the edge runs. Auto-run stays a
 *   pointer-only rule, as in the prototype: on keys and on a stick, Shift runs, which is
 *   what every other body in this game does and what the blob's other scheme does.
 * - **The character's facing eases instead of snapping.** The prototype's `lerpAngle` was
 *   passed a factor of 1. A snap reads as a glitch on a skinned character; it did not on
 *   the prototype's simpler one.
 *
 * What is kept faithfully, and must stay that way for this to be recognisably blobby:
 * the pointer's small x dead zone before it steers, the forward bias that makes a plain
 * hold walk, the keyboard turn axis overriding the pointer's (the prototype applies
 * left/right *after* its click block, so it wins), and the facing being retained rather
 * than reset when input stops.
 */
import { BLOBBY } from './gameplayConfig';

/** The subset of a DOMRect this needs, so a caller can pass a real rect and a test can
 * pass an object literal without standing up a DOM. */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A held pointer in client space, as `setBlobPointer` records it. */
export interface PointerPosition {
  x: number;
  y: number;
}

/**
 * A pointer's position as the prototype's `mouse` vector: -1..1 across the view with +1 at
 * the top, which is R3F's convention and not the DOM's. Null when the view has no area to
 * measure against — a canvas that has not been laid out yet reports 0x0, and dividing by
 * it yields infinities that would otherwise reach the movement maths.
 */
export function pointerViewOffset(pointer: PointerPosition, rect: ViewRect): PointerPosition | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: clamp(((pointer.x - rect.left) / rect.width) * 2 - 1, -1, 1),
    y: clamp(-(((pointer.y - rect.top) / rect.height) * 2 - 1), -1, 1),
  };
}

/** One tick of input, in the same axis conventions `PlayerInputState` uses: `turn`
 * positive is left, `forward` positive is ahead. */
export interface BlobbyControlInput {
  turn: number;
  forward: number;
  boost: boolean;
  /** A held pointer's view offset (see `pointerViewOffset`), or null when nothing is
   * held. */
  pointer: PointerPosition | null;
}

/** What the scheme carries between ticks. All three are angles in radians. */
export interface BlobbyControlState {
  /** The camera's own orbit yaw — the prototype's `rotationTarget`. */
  cameraYaw: number;
  /** The blob's facing relative to that yaw — the prototype's `characterRotationTarget`. */
  facingOffset: number;
  /** The blob's eased world facing, which is what the model is actually rotated to. */
  heading: number;
}

export interface BlobbyControlResult extends BlobbyControlState {
  /** World heading to move along this tick: `cameraYaw + facingOffset`, taken before the
   * easing so the blob walks where the input points rather than where its mesh has so far
   * turned to. */
  headingForMotion: number;
  /** 0..1 of the pace to apply. 0 exactly when the blob should stand and play 'idle'. */
  moveMagnitude: number;
  running: boolean;
}

export type BlobbyConfig = typeof BLOBBY;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Merge of the pointer and the keyboard into the prototype's `movementX`/`movementZ`.
 *
 * Order matters and is the prototype's: a held pointer replaces both axes, and then the
 * keyboard's turn is applied over the top of it. That is why holding a drag and pressing
 * A still turns left rather than fighting the drag.
 */
function blobbyAxes(input: BlobbyControlInput, config: BlobbyConfig): { turn: number; forward: number } {
  let turn = input.turn;
  let forward = input.forward;
  if (input.pointer) {
    // A small dead zone before the pointer steers at all, so a hold that is only trying to
    // walk forward does not also drift the camera round.
    if (Math.abs(input.pointer.x) > config.pointerTurnDeadZone) turn = -input.pointer.x;
    // The forward bias is what makes a plain hold a walk rather than a stand. Clamped,
    // unlike the prototype, whose `mouse.y + 0.4` reaches 1.4 at the top of the screen —
    // harmless there because the magnitude was binary, but not once it sets the pace.
    forward = clamp(input.pointer.y + config.pointerForwardBias, -1, 1);
  }
  if (input.turn !== 0) turn = input.turn;
  return { turn: clamp(turn, -1, 1), forward: clamp(forward, -1, 1) };
}

/**
 * Advances one tick of the scheme. Pure: same input and state in, same result out, with
 * no reads of the clock or the DOM — `dt` and the pointer offset are both passed in.
 */
export function resolveBlobbyControl(
  input: BlobbyControlInput,
  state: BlobbyControlState,
  dt: number,
  config: BlobbyConfig = BLOBBY,
): BlobbyControlResult {
  const { turn, forward } = blobbyAxes(input, config);
  const magnitude = Math.min(1, Math.hypot(turn, forward));
  const moving = magnitude > config.moveEpsilon;

  // The camera orbits on the turn axis alone, exactly as the prototype's `rotationTarget`
  // only ever moved on `movementX`. Not eased here: the camera rig this feeds already
  // slerps toward its placement on CAMERA.easeTau, and easing the same angle twice reads
  // as the view lagging the controls.
  const cameraYaw = state.cameraYaw + turn * config.cameraYawRateRadPerS * dt;
  // Retained, not zeroed, when there is no input — the prototype keeps its last facing,
  // so the blob stays pointed where it stopped rather than snapping back to the camera.
  const facingOffset = moving ? Math.atan2(turn, forward) : state.facingOffset;
  const headingForMotion = cameraYaw + facingOffset;

  return {
    cameraYaw,
    facingOffset,
    heading: easeAngle(state.heading, headingForMotion, dt, config.facingTau),
    headingForMotion,
    moveMagnitude: moving ? magnitude : 0,
    // Auto-run is a pointer-only rule, as in the prototype. Extending it to the keyboard
    // would make a plain W a run and leave no way to walk at all, since a held key is a
    // full-deflection axis the instant it goes down.
    running: input.boost || (input.pointer !== null && magnitude > config.runMagnitude),
  };
}

/**
 * Eases `from` toward `to` the short way round the circle, frame-rate independently.
 *
 * The wrap matters: easing 350deg toward 10deg by subtracting raw angles takes the long
 * way and spins the character most of a turn to reach a heading a few degrees away. The
 * `atan2(sin, cos)` pair is the branch-free way to get the signed shortest delta, and is
 * what the prototype's `lerpAngle` open-codes with its normalize-and-compare.
 */
export function easeAngle(from: number, to: number, dt: number, tau: number): number {
  if (!(tau > 0)) return to;
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * (1 - Math.exp(-dt / tau));
}
