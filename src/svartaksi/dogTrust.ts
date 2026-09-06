/**
 * Persistence for the dog companion's trust arc (backlog item 16). Only
 * `behavior` and `trust` survive a reload — position/heading are runtime-only
 * and the dog respawns at an authored point each session, the same way an
 * in-progress stalk does not need to resume mid-flee. Mirrors
 * storyEngine.ts's serialize/load/storage/reset-registry shape exactly, since
 * item 16 shares item 11's persistence problem rather than needing a new one.
 */
import type { DogBehaviorState, DogState } from './dogCompanion';

export interface SerializedDogTrust {
  behavior: DogBehaviorState;
  trust: number;
}

/** localStorage key, registered with SVARTAKSI_STORAGE_KEYS in resetGame.ts so
 * "reset all settings" clears the dog's trust along with everything else
 * Svartaksi owns. */
export const DOG_TRUST_STORAGE_KEY = 'svartaksi.dog.v1';

export function serializeDogTrust(state: DogState): SerializedDogTrust {
  return { behavior: state.behavior, trust: state.trust };
}

export function loadDogTrust(serialized: SerializedDogTrust): Pick<DogState, 'behavior' | 'trust'> {
  return { behavior: serialized.behavior, trust: serialized.trust };
}

const DEFAULT_DOG_TRUST: Pick<DogState, 'behavior' | 'trust'> = { behavior: 'stalking', trust: 0 };

const VALID_BEHAVIORS = ['stalking', 'wary', 'following', 'companion'] as const;

/** Reads a previously-saved value, or the default (stalking, 0 trust) if
 * there is none or it is corrupt — a broken save should restart the arc, not
 * crash the app. */
export function loadDogTrustFromStorage(storage: Pick<Storage, 'getItem'>): Pick<DogState, 'behavior' | 'trust'> {
  try {
    const raw = storage.getItem(DOG_TRUST_STORAGE_KEY);
    if (!raw) return DEFAULT_DOG_TRUST;
    const parsed = JSON.parse(raw) as Partial<SerializedDogTrust>;
    if (
      !parsed.behavior ||
      !VALID_BEHAVIORS.includes(parsed.behavior as DogBehaviorState) ||
      typeof parsed.trust !== 'number' ||
      !Number.isFinite(parsed.trust) ||
      parsed.trust < 0 ||
      parsed.trust > 100
    )
      return DEFAULT_DOG_TRUST;
    return loadDogTrust({ behavior: parsed.behavior as DogBehaviorState, trust: parsed.trust });
  } catch {
    return DEFAULT_DOG_TRUST;
  }
}

export function saveDogTrustToStorage(storage: Pick<Storage, 'setItem'>, state: DogState): void {
  storage.setItem(DOG_TRUST_STORAGE_KEY, JSON.stringify(serializeDogTrust(state)));
}
