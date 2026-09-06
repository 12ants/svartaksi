import { describe, expect, it } from 'vitest';
import {
  easeAngle,
  pointerViewOffset,
  resolveBlobbyControl,
  type BlobbyControlInput,
  type BlobbyControlState,
} from '../../src/svartaksi/blobControls';
import { BLOBBY } from '../../src/svartaksi/gameplayConfig';

/** A 800x600 view at the origin, so a client coordinate reads as an obvious fraction. */
const RECT = { left: 0, top: 0, width: 800, height: 600 };
const CENTRE = { x: 400, y: 300 };

const rest: BlobbyControlState = { cameraYaw: 0, facingOffset: 0, heading: 0 };
const idle: BlobbyControlInput = { turn: 0, forward: 0, boost: false, pointer: null };
const held = (client: { x: number; y: number }) => pointerViewOffset(client, RECT);

describe('pointerViewOffset', () => {
  it('reads the view centre as the origin and the corners as the unit square', () => {
    // toBeCloseTo rather than toEqual: negating the y axis yields -0, which is a distinct
    // value to toEqual and the same number to everything that matters here.
    expect(held(CENTRE)?.x).toBeCloseTo(0, 10);
    expect(held(CENTRE)?.y).toBeCloseTo(0, 10);
    // +y is up, which is R3F's convention and the opposite of the DOM's.
    expect(held({ x: 800, y: 0 })).toEqual({ x: 1, y: 1 });
    expect(held({ x: 0, y: 600 })).toEqual({ x: -1, y: -1 });
  });

  it('clamps a pointer dragged outside the view', () => {
    expect(held({ x: 4_000, y: -4_000 })).toEqual({ x: 1, y: 1 });
  });

  it('refuses a view with no area rather than returning infinities', () => {
    // A canvas that has not been laid out yet reports 0x0; dividing by that reaches the
    // movement maths as NaN and leaves the blob's heading permanently NaN.
    expect(pointerViewOffset(CENTRE, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});

describe('resolveBlobbyControl', () => {
  it('stands still, and holds its facing, with no input at all', () => {
    const result = resolveBlobbyControl(idle, { ...rest, facingOffset: 1.2, heading: 1.2 }, 1 / 60);
    expect(result.moveMagnitude).toBe(0);
    expect(result.running).toBe(false);
    // Retained rather than zeroed, same as the prototype: the blob stays pointed where it
    // stopped instead of snapping back to face the camera.
    expect(result.facingOffset).toBe(1.2);
    expect(result.cameraYaw).toBe(0);
  });

  it('orbits the camera on the turn axis, at the configured rate', () => {
    const dt = 0.5;
    const result = resolveBlobbyControl({ ...idle, turn: 1 }, rest, dt);
    expect(result.cameraYaw).toBeCloseTo(BLOBBY.cameraYawRateRadPerS * dt, 6);
    // Frame-rate independent: two half-steps land where one whole one does.
    const halved = resolveBlobbyControl(
      { ...idle, turn: 1 },
      resolveBlobbyControl({ ...idle, turn: 1 }, rest, dt / 2),
      dt / 2,
    );
    expect(halved.cameraYaw).toBeCloseTo(result.cameraYaw, 6);
  });

  it('walks along the camera yaw plus the facing the input implies', () => {
    // Forward with the camera already a quarter turn round: the blob walks along the
    // camera's own axis, not the world's.
    const result = resolveBlobbyControl(
      { ...idle, forward: 1 },
      { ...rest, cameraYaw: Math.PI / 2 },
      1 / 60,
    );
    expect(result.facingOffset).toBeCloseTo(0, 6);
    expect(result.headingForMotion).toBeCloseTo(Math.PI / 2, 6);
  });

  it('faces a quarter turn off the camera when only the turn axis is pressed', () => {
    // atan2(turn, forward) with forward 0 — the prototype's own behaviour, and why
    // holding A alone walks across the view rather than backing away from it.
    const result = resolveBlobbyControl({ ...idle, turn: 1 }, rest, 1 / 60);
    expect(result.facingOffset).toBeCloseTo(Math.PI / 2, 6);
  });

  describe('movement magnitude is analog, not the prototype\'s binary', () => {
    it('scales the pace with a partly-deflected stick', () => {
      // The prototype moved at a fixed speed for any non-zero axis, which made a touch
      // joystick at 30% run at full pace.
      const result = resolveBlobbyControl({ ...idle, forward: 0.3 }, rest, 1 / 60);
      expect(result.moveMagnitude).toBeCloseTo(0.3, 6);
      expect(result.running).toBe(false);
    });

    it('never exceeds 1 on a diagonal', () => {
      const result = resolveBlobbyControl({ ...idle, turn: 1, forward: 1 }, rest, 1 / 60);
      expect(result.moveMagnitude).toBe(1);
    });

    it('treats a stick resting fractionally off centre as idle', () => {
      const result = resolveBlobbyControl({ ...idle, forward: BLOBBY.moveEpsilon / 2 }, rest, 1 / 60);
      expect(result.moveMagnitude).toBe(0);
    });
  });

  describe('running', () => {
    it('runs on boost however small the movement', () => {
      expect(resolveBlobbyControl({ ...idle, forward: 0.2, boost: true }, rest, 1 / 60).running).toBe(true);
    });

    it('walks on a full keyboard press, so Shift is still what runs', () => {
      // Auto-run is a pointer-only rule. A held key is a full-deflection axis the instant
      // it goes down, so a magnitude rule that covered the keyboard too would make a plain
      // W a run and leave no way to walk at all.
      expect(resolveBlobbyControl({ ...idle, forward: 1 }, rest, 1 / 60).running).toBe(false);
    });

    it('leaves a usable walk band for a pointer held near the centre', () => {
      // The whole point of moving the threshold past the forward bias: a centre hold used
      // to be a run, so walking with the pointer was effectively unreachable.
      const result = resolveBlobbyControl({ ...idle, pointer: held(CENTRE) }, rest, 1 / 60);
      expect(result.moveMagnitude).toBeCloseTo(BLOBBY.pointerForwardBias, 6);
      expect(result.running).toBe(false);
    });
  });

  describe('held pointer', () => {
    it('walks forward on a plain hold at the centre, rather than standing', () => {
      // blobby's forward bias, kept: the pointer says which way to lean, the hold says go.
      const result = resolveBlobbyControl({ ...idle, pointer: held(CENTRE) }, rest, 1 / 60);
      expect(result.moveMagnitude).toBeGreaterThan(0);
      expect(result.facingOffset).toBeCloseTo(0, 6);
    });

    it('ignores an x-offset inside the dead zone, so a forward hold does not drift', () => {
      const justInside = { x: 400 + (BLOBBY.pointerTurnDeadZone * 0.5) * 400, y: 300 };
      expect(resolveBlobbyControl({ ...idle, pointer: held(justInside) }, rest, 1 / 60).cameraYaw).toBe(0);
    });

    it('steers, and orbits the camera, once past the dead zone', () => {
      // Dragging right should turn right: a right-of-centre pointer is a negative turn.
      const right = { x: 700, y: 300 };
      const result = resolveBlobbyControl({ ...idle, pointer: held(right) }, rest, 1 / 60);
      expect(result.cameraYaw).toBeLessThan(0);
      expect(result.facingOffset).toBeLessThan(0);
    });

    it('runs when the drag reaches for the edge', () => {
      expect(resolveBlobbyControl({ ...idle, pointer: held({ x: 800, y: 0 }) }, rest, 1 / 60).running).toBe(true);
    });

    it('clamps the biased forward axis instead of letting it reach 1.4', () => {
      // The prototype's `mouse.y + 0.4` overruns the -1..1 every other axis here is
      // clamped to. Harmless while the magnitude was binary; not once it sets the pace.
      const result = resolveBlobbyControl({ ...idle, pointer: held({ x: 400, y: 0 }) }, rest, 1 / 60);
      expect(result.moveMagnitude).toBe(1);
    });

    it('walks backward when dragged below the bias', () => {
      const result = resolveBlobbyControl({ ...idle, pointer: held({ x: 400, y: 600 }) }, rest, 1 / 60);
      // -1 + 0.4 bias.
      expect(result.moveMagnitude).toBeCloseTo(0.6, 6);
      expect(Math.abs(result.facingOffset)).toBeCloseTo(Math.PI, 6);
    });

    it('lets the keyboard turn override the pointer, as the prototype does', () => {
      // The prototype applies left/right *after* its click block, so a key wins. Holding
      // a drag to the right while pressing A must still turn left.
      const result = resolveBlobbyControl(
        { turn: 1, forward: 0, boost: false, pointer: held({ x: 700, y: 300 }) },
        rest,
        1 / 60,
      );
      expect(result.cameraYaw).toBeGreaterThan(0);
    });
  });

  describe('facing easing', () => {
    it('eases toward the movement heading rather than snapping to it', () => {
      const result = resolveBlobbyControl({ ...idle, forward: 1 }, { ...rest, heading: 1 }, 1 / 60);
      expect(result.heading).toBeLessThan(1);
      expect(result.heading).toBeGreaterThan(0);
      // Motion follows the input immediately even while the mesh is still turning, so the
      // blob never crabs sideways for the length of the ease.
      expect(result.headingForMotion).toBeCloseTo(0, 6);
    });

    it('converges on the target when held', () => {
      let state = { ...rest, heading: 3 };
      for (let step = 0; step < 200; step += 1) {
        state = resolveBlobbyControl({ ...idle, forward: 1 }, state, 1 / 60);
      }
      expect(state.heading).toBeCloseTo(0, 4);
    });
  });
});

describe('easeAngle', () => {
  it('takes the short way round the wrap instead of unwinding a full turn', () => {
    // 350deg to 10deg is 20deg the short way and 340deg the long way. Subtracting raw
    // angles takes the long way, which spins the character almost all the way round.
    const from = (350 * Math.PI) / 180;
    const to = (370 * Math.PI) / 180; // 10deg, one wrap on
    const stepped = easeAngle(from, to, 1 / 60, 0.12);
    expect(stepped).toBeGreaterThan(from);
    expect(stepped - from).toBeLessThan(Math.PI / 4);
  });

  it('snaps when given no time constant to ease over', () => {
    expect(easeAngle(0, 1, 1 / 60, 0)).toBe(1);
  });
});
