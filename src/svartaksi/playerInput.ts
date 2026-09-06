export interface PlayerInputState {
  forward: number;
  turn: number;
  boost: boolean;
  brake: boolean;
  lookX: number;
  lookY: number;
  vertical: number;
  /** On-foot jump — vertical impulse on press, gated to grounded pill/blob. */
  jump: boolean;
  /** On-foot crouch, held — lowers the capsule and slows movement while active. */
  crouch: boolean;
}

export type PlayerInputSource = 'keyboard' | 'touch';

/**
 * Which input scheme drives the blob character. 'direct' is this project's usual
 * tank-style scheme (see the on-foot/blob movement block in svartaksiRuntime.tsx): WASD maps
 * straight onto forward/turn, and a held drag stands in for the same two axes. 'blobby'
 * is the alternate scheme ported from docs/misc/blobby/src/components/CharacterController.jsx:
 * held-pointer movement is read relative to camera-centre, the character's own facing
 * eases independently of the camera's orbit, and the camera itself orbits on mouse-x
 * rather than always sitting behind whichever way the character is facing.
 */
export const BLOB_CONTROL_SCHEMES = ['direct', 'blobby'] as const;
export type BlobControlScheme = typeof BLOB_CONTROL_SCHEMES[number];

export function isBlobControlScheme(value: unknown): value is BlobControlScheme {
  return typeof value === 'string' && (BLOB_CONTROL_SCHEMES as readonly string[]).includes(value);
}

export interface PlayerInputController {
  setSourceState(source: PlayerInputSource, state: Partial<PlayerInputState>): void;
  releaseSource(source: PlayerInputSource): void;
  snapshot(): PlayerInputState;
}

const AXES: ReadonlyArray<keyof Pick<PlayerInputState, 'forward' | 'turn' | 'lookX' | 'lookY' | 'vertical'>> = [
  'forward',
  'turn',
  'lookX',
  'lookY',
  'vertical',
];

function emptyInput(): PlayerInputState {
  return {
    forward: 0,
    turn: 0,
    boost: false,
    brake: false,
    lookX: 0,
    lookY: 0,
    vertical: 0,
    jump: false,
    crouch: false,
  };
}

function clampAxis(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
}

export function createPlayerInputController(): PlayerInputController {
  const sources: Record<PlayerInputSource, PlayerInputState> = {
    keyboard: emptyInput(),
    touch: emptyInput(),
  };

  return {
    setSourceState(source, state) {
      const next = { ...sources[source], ...state };
      for (const axis of AXES) next[axis] = clampAxis(next[axis]);
      sources[source] = next;
    },
    releaseSource(source) {
      sources[source] = emptyInput();
    },
    snapshot() {
      const keyboard = sources.keyboard;
      const touch = sources.touch;
      const merged = emptyInput();
      for (const axis of AXES) {
        merged[axis] = Math.abs(touch[axis]) > Math.abs(keyboard[axis])
          ? touch[axis]
          : keyboard[axis];
      }
      merged.boost = keyboard.boost || touch.boost;
      merged.brake = keyboard.brake || touch.brake;
      merged.jump = keyboard.jump || touch.jump;
      merged.crouch = keyboard.crouch || touch.crouch;
      return merged;
    },
  };
}
