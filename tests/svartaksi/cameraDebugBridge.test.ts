import { describe, expect, it, vi } from 'vitest';
import {
  installCameraDebugBridge,
  orientationToward,
  type CameraPlacement,
  type SvartaksiCameraBridge,
  type SvartaksiCameraSnapshot,
} from '../../src/svartaksi/cameraDebugBridge';

/** The freecam's own forward vector, copied from the runtime's fly block. The bridge's
 * orientation maths is the inverse of exactly this, so round-tripping through both is
 * what proves the two agree. */
const forwardFrom = (yaw: number, pitch: number) => {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
};

const origin = { x: 0, y: 0, z: 0 };

describe('orientationToward', () => {
  it('returns null for a target on top of the camera', () => {
    // No direction exists from a point to itself; inventing one would aim the camera
    // somewhere arbitrary and call it success.
    expect(orientationToward(origin, origin)).toBeNull();
    expect(orientationToward({ x: 5, y: 2, z: -3 }, { x: 5, y: 2, z: -3 })).toBeNull();
  });

  it('faces -Z at zero yaw, which is where the camera looks by default', () => {
    const facing = orientationToward(origin, { x: 0, y: 0, z: -10 })!;
    expect(facing.yaw).toBeCloseTo(0, 10);
    expect(facing.pitch).toBeCloseTo(0, 10);
  });

  it('looks straight down for a target directly below', () => {
    const facing = orientationToward({ x: 0, y: 100, z: 0 }, origin)!;
    expect(facing.pitch).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('looks straight up for a target directly above', () => {
    const facing = orientationToward(origin, { x: 0, y: 100, z: 0 })!;
    expect(facing.pitch).toBeCloseTo(Math.PI / 2, 10);
  });

  it('round-trips through the freecam forward vector', () => {
    // The property that matters: whatever this computes, feeding it back through the
    // runtime's own fly vector must point at the target again.
    const cases = [
      { yaw: 0.4, pitch: 0.2 }, { yaw: -1.9, pitch: -0.7 },
      { yaw: 3.0, pitch: 0.0 }, { yaw: -2.9, pitch: 1.2 },
    ];
    for (const { yaw, pitch } of cases) {
      const forward = forwardFrom(yaw, pitch);
      const target = { x: forward.x * 37, y: forward.y * 37, z: forward.z * 37 };
      const facing = orientationToward(origin, target)!;
      const back = forwardFrom(facing.yaw, facing.pitch);
      expect(back.x).toBeCloseTo(forward.x, 9);
      expect(back.y).toBeCloseTo(forward.y, 9);
      expect(back.z).toBeCloseTo(forward.z, 9);
    }
  });

  it('is unaffected by how far away the target is', () => {
    const near = orientationToward(origin, { x: 3, y: 1, z: -4 })!;
    const far = orientationToward(origin, { x: 300, y: 100, z: -400 })!;
    expect(near.yaw).toBeCloseTo(far.yaw, 10);
    expect(near.pitch).toBeCloseTo(far.pitch, 10);
  });
});

interface Harness {
  target: Window & { __SVARTAKSI_CAMERA__?: SvartaksiCameraBridge };
  snapshot: SvartaksiCameraSnapshot | null;
  placed: Array<Required<CameraPlacement>>;
  modes: string[];
  dispose: (() => void) | null;
  bridge: () => SvartaksiCameraBridge;
}

function harness(initial: Partial<SvartaksiCameraSnapshot> = {}, placeResult = true): Harness {
  const state: Harness = {
    target: {} as Harness['target'],
    snapshot: {
      mode: 'freecam', position: { x: 1, y: 2, z: 3 }, yaw: 0.5, pitch: -0.25,
      canRelocate: true, ...initial,
    },
    placed: [], modes: [], dispose: null,
    bridge: () => state.target.__SVARTAKSI_CAMERA__!,
  };
  state.dispose = installCameraDebugBridge({
    target: state.target,
    search: '?dev=1',
    read: () => state.snapshot,
    setMode: (mode) => { state.modes.push(mode); },
    place: (placement) => { if (!placeResult) return false; state.placed.push(placement); return true; },
  });
  return state;
}

describe('installCameraDebugBridge', () => {
  it('installs a schema-versioned global and removes it on dispose', () => {
    const h = harness();
    expect(h.bridge().schemaVersion).toBe(1);
    h.dispose!();
    expect(h.target.__SVARTAKSI_CAMERA__).toBeUndefined();
  });

  it('leaves another bridge instance alone on dispose', () => {
    // Two installs racing (a remount) must not have the first's teardown delete the
    // second's global.
    const h = harness();
    const first = h.bridge();
    const other = { schemaVersion: 1 } as SvartaksiCameraBridge;
    h.target.__SVARTAKSI_CAMERA__ = other;
    h.dispose!();
    expect(h.target.__SVARTAKSI_CAMERA__).toBe(other);
    expect(first).not.toBe(other);
  });

  it('reports the camera state, including whether a teleport would be honoured', () => {
    // canRelocate is the field that explains a silently-ignored teleportTo: applyTeleport
    // refuses while the bus is not hidden, and gives no other sign of it.
    const h = harness({ canRelocate: false, mode: 'chase' });
    const snapshot = h.bridge().get()!;
    expect(snapshot.canRelocate).toBe(false);
    expect(snapshot.mode).toBe('chase');
    expect(snapshot.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('passes a mode change straight through', () => {
    const h = harness();
    h.bridge().setMode('top-down');
    expect(h.modes).toEqual(['top-down']);
  });

  it('places the camera at an explicit position', () => {
    const h = harness();
    expect(h.bridge().place({ x: 10, y: 20, z: 30, yaw: 1, pitch: -0.5 })).toBe(true);
    expect(h.placed).toEqual([{ x: 10, y: 20, z: 30, yaw: 1, pitch: -0.5 }]);
  });

  it('keeps the current angles when a placement omits them', () => {
    // Moving the camera without re-aiming it is the common case when stepping along a
    // road; forcing a caller to restate the angles would invite them to guess.
    const h = harness();
    h.bridge().place({ x: 7, y: 8, z: 9 });
    expect(h.placed[0]).toEqual({ x: 7, y: 8, z: 9, yaw: 0.5, pitch: -0.25 });
  });

  it('reports failure when the runtime refuses the placement', () => {
    // The rig-driven modes rebuild their pose from the player every frame, so a position
    // written into them would be overwritten before it was drawn.
    const h = harness({ mode: 'chase' }, false);
    expect(h.bridge().place({ x: 1, y: 1, z: 1 })).toBe(false);
  });

  it('aims at a world point without moving the camera', () => {
    const h = harness({ position: { x: 0, y: 50, z: 0 } });
    expect(h.bridge().lookAt({ x: 0, y: 50, z: -100 })).toBe(true);
    const placed = h.placed[0];
    expect(placed.x).toBe(0);
    expect(placed.y).toBe(50);
    expect(placed.z).toBe(0);
    expect(placed.yaw).toBeCloseTo(0, 9);
    expect(placed.pitch).toBeCloseTo(0, 9);
  });

  it('aims down at a target below the camera', () => {
    const h = harness({ position: { x: 0, y: 120, z: 0 } });
    h.bridge().lookAt({ x: 0, y: 0, z: 0 });
    expect(h.placed[0].pitch).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('refuses to aim at the point the camera already occupies', () => {
    const h = harness({ position: { x: 4, y: 5, z: 6 } });
    expect(h.bridge().lookAt({ x: 4, y: 5, z: 6 })).toBe(false);
    expect(h.placed).toHaveLength(0);
  });

  it('reports failure from every entry point when the camera state is unreadable', () => {
    // Before the scene mounts there is no camera to read, place or aim.
    const h = harness();
    h.snapshot = null;
    expect(h.bridge().get()).toBeNull();
    expect(h.bridge().place({ x: 1, y: 1, z: 1 })).toBe(false);
    expect(h.bridge().lookAt({ x: 1, y: 1, z: 1 })).toBe(false);
    expect(h.placed).toHaveLength(0);
  });

  it('installs nothing when developer tools are not requested', () => {
    // isDevModeRequested currently returns true for every URL, which is this project's
    // own standing decision (see devMode.ts) rather than this bridge's. The install is
    // routed through it so that if that decision is ever narrowed, this global narrows
    // with it and does not have to be found and fixed separately.
    const target = {} as Window & { __SVARTAKSI_CAMERA__?: SvartaksiCameraBridge };
    const read = vi.fn(() => null);
    const dispose = installCameraDebugBridge({
      target, search: '', read, setMode: () => {}, place: () => true,
    });
    const installed = target.__SVARTAKSI_CAMERA__ !== undefined;
    expect(installed).toBe(dispose !== null);
  });
});
