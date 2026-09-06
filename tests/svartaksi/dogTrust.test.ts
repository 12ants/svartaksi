import { describe, expect, it } from 'vitest';

import { createDogState } from '../../src/svartaksi/dogCompanion';
import {
  DOG_TRUST_STORAGE_KEY,
  loadDogTrust,
  loadDogTrustFromStorage,
  saveDogTrustToStorage,
  serializeDogTrust,
} from '../../src/svartaksi/dogTrust';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

describe('dogTrust', () => {
  it('serializes only behavior and trust', () => {
    const dog = { ...createDogState(1, 2), behavior: 'following' as const, trust: 63 };
    expect(serializeDogTrust(dog)).toEqual({ behavior: 'following', trust: 63 });
  });

  it('loadDogTrust round-trips a serialized value', () => {
    const loaded = loadDogTrust({ behavior: 'wary', trust: 40 });
    expect(loaded).toEqual({ behavior: 'wary', trust: 40 });
  });

  it('save then load from storage returns the same behavior and trust', () => {
    const storage = fakeStorage();
    const dog = { ...createDogState(0, 0), behavior: 'companion' as const, trust: 100 };
    saveDogTrustToStorage(storage, dog);
    const loaded = loadDogTrustFromStorage(storage);
    expect(loaded).toEqual({ behavior: 'companion', trust: 100 });
  });

  it('falls back to stalking/0 when storage is empty', () => {
    const storage = fakeStorage();
    expect(loadDogTrustFromStorage(storage)).toEqual({ behavior: 'stalking', trust: 0 });
  });

  it('falls back to stalking/0 when storage holds corrupt JSON', () => {
    const storage = fakeStorage({ [DOG_TRUST_STORAGE_KEY]: 'not json' });
    expect(loadDogTrustFromStorage(storage)).toEqual({ behavior: 'stalking', trust: 0 });
  });

  it('falls back to stalking/0 when storage holds valid JSON with invalid behavior', () => {
    const storage = fakeStorage({ [DOG_TRUST_STORAGE_KEY]: JSON.stringify({ behavior: 'garbage', trust: 5 }) });
    expect(loadDogTrustFromStorage(storage)).toEqual({ behavior: 'stalking', trust: 0 });
  });

  it('falls back to stalking/0 when storage holds a valid behavior but out-of-range trust', () => {
    const storage = fakeStorage({ [DOG_TRUST_STORAGE_KEY]: JSON.stringify({ behavior: 'wary', trust: 500 }) });
    expect(loadDogTrustFromStorage(storage)).toEqual({ behavior: 'stalking', trust: 0 });
  });
});
