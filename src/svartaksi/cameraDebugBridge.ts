/**
 * Opt-in debug surface for placing and reading the camera, so a script driving the game
 * from outside can frame a specific piece of the world without flying there on synthetic
 * keypresses.
 *
 * Mirrors `busRiderDebugBridge.ts`'s shape — a typed, schema-versioned
 * `window.__SVARTAKSI_*__` global installed through `isDevModeRequested` — and is a
 * separate global for the same reason that one is separate from the dog and performance
 * bridges: this is camera state, and nothing else.
 *
 * The motivating case was a screenshot. Freecam flies at `FREECAM.speed` along whatever
 * direction it is already facing, so aiming it at a bridge 300m away over a slow
 * software renderer meant a dozen synthetic key-holds, each guessed, each costing a
 * frame budget to observe. `place` and `lookAt` turn that into one call with coordinates
 * in it.
 *
 * **This exposes no capability a player does not already have.** Freecam is a normal
 * camera mode reachable with the C key, and this only sets the position and angles that
 * mode already flies under. In particular it deliberately does *not* offer a way past
 * `canRelocateWorld` — see `canRelocate` on the snapshot.
 */
import { isDevModeRequested } from './devMode';
import type { CameraMode } from './cameraModes';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface SvartaksiCameraSnapshot {
  mode: CameraMode;
  /** Camera position in world metres. */
  position: Vec3Like;
  /** Freecam yaw/pitch in radians. Meaningful in freecam; in the rig-driven modes these
   * are whatever the last freecam entry left behind, not the live view. */
  yaw: number;
  pitch: number;
  /**
   * Whether `teleportTo` would actually be honoured right now.
   *
   * `applyTeleport` is guarded by `canRelocateWorld`, which only permits a relocation
   * while the bus is fully hidden — and it refuses *silently*. A caller that teleports
   * during the opening ride and then wonders why the world did not change has no way to
   * tell that from a teleport that worked, which is exactly the confusion this field
   * exists to end. It is a report, not a switch: nothing here bypasses the guard.
   */
  canRelocate: boolean;
}

export interface CameraPlacement extends Vec3Like {
  /** Radians. Left at the current value when omitted. */
  yaw?: number;
  pitch?: number;
}

export interface SvartaksiCameraBridge {
  readonly schemaVersion: 1;
  get(): SvartaksiCameraSnapshot | null;
  /** Switches camera mode, exactly as the C key does. */
  setMode(mode: CameraMode): void;
  /**
   * Puts the freecam at a world position, optionally facing a given yaw/pitch. Returns
   * false when the camera is not in freecam — the rig-driven modes derive their pose
   * from the player every frame, so a position written into them would be overwritten
   * before it was ever drawn, and silently accepting that would be a lie.
   */
  place(placement: CameraPlacement): boolean;
  /**
   * Aims the freecam at a world point, leaving its position alone. Returns false when
   * not in freecam, or when the target coincides with the camera (no direction to face).
   */
  lookAt(target: Vec3Like): boolean;
  /**
   * Moves the *world anchor* — the player — to a local ground point, so the streamer
   * builds the world there.
   *
   * `place` alone is not enough to see somewhere: the world is streamed and built around
   * the player, not around the camera, so a camera placed a few hundred metres out looks
   * at bare terrain with roads floating on it, and further out at nothing at all. Worse,
   * during the opening bus ride the player is *moving*, so a fixed world coordinate
   * drifts out of the built region while you are looking at it — which reads exactly like
   * a camera that is pointing the wrong way.
   *
   * Returns false when `canRelocate` is false (see the snapshot field), which is the
   * silent refusal in `applyTeleport` made visible. Nothing here bypasses that guard.
   */
  moveTo(target: { x: number; z: number }): boolean;
}

declare global {
  interface Window {
    __SVARTAKSI_CAMERA__?: SvartaksiCameraBridge;
  }
}

export function isCameraDebugRequested(search: string): boolean {
  return isDevModeRequested(search);
}

/**
 * Yaw and pitch that face `from` toward `to`, in the convention the freecam's own fly
 * vector uses: the camera looks down its -Z, so its forward is
 * `(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`.
 *
 * This is the exact inverse the runtime already performs when it seeds freecam from the
 * live camera — kept as one pure function so the two cannot drift apart, and so the
 * round trip can be tested without a canvas.
 *
 * Returns null when the two points coincide: there is no direction from a point to
 * itself, and inventing one would silently aim the camera somewhere arbitrary.
 */
export function orientationToward(from: Vec3Like, to: Vec3Like): { yaw: number; pitch: number } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) return null;
  return {
    yaw: Math.atan2(-dx / length, -dz / length),
    pitch: Math.asin(Math.max(-1, Math.min(1, dy / length))),
  };
}

export interface InstallCameraDebugBridgeOptions {
  target?: Window & { __SVARTAKSI_CAMERA__?: SvartaksiCameraBridge };
  search?: string;
  /** Reads the current frame's camera state. Injected rather than imported so this
   * module has no dependency on the runtime's own refs. */
  read: () => SvartaksiCameraSnapshot | null;
  setMode: (mode: CameraMode) => void;
  /** Writes the freecam pose. Returns false when the camera is not in freecam. */
  place: (placement: Required<CameraPlacement>) => boolean;
  /** Relocates the world anchor. Returns false when the world may not be relocated. */
  moveWorld: (x: number, z: number) => boolean;
}

/**
 * Installs `window.__SVARTAKSI_CAMERA__` when developer tools are available, or does
 * nothing and returns null otherwise. Returns a dispose function that removes it, or
 * null when nothing was installed.
 */
export function installCameraDebugBridge({
  target = window,
  search = target.location.search,
  read,
  setMode,
  place,
  moveWorld,
}: InstallCameraDebugBridgeOptions): (() => void) | null {
  if (!isCameraDebugRequested(search)) return null;

  const bridge: SvartaksiCameraBridge = {
    schemaVersion: 1,
    get: () => read(),
    setMode: (mode) => setMode(mode),
    place: (placement) => {
      const current = read();
      if (!current) return false;
      return place({
        x: placement.x,
        y: placement.y,
        z: placement.z,
        yaw: placement.yaw ?? current.yaw,
        pitch: placement.pitch ?? current.pitch,
      });
    },
    lookAt: (targetPoint) => {
      const current = read();
      if (!current) return false;
      const facing = orientationToward(current.position, targetPoint);
      if (!facing) return false;
      return place({ ...current.position, yaw: facing.yaw, pitch: facing.pitch });
    },
    moveTo: (target) => moveWorld(target.x, target.z),
  };
  target.__SVARTAKSI_CAMERA__ = bridge;

  return () => {
    if (target.__SVARTAKSI_CAMERA__ === bridge) delete target.__SVARTAKSI_CAMERA__;
  };
}
