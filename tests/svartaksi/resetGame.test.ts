import { describe, expect, it } from 'vitest';

import { SVARTAKSI_LEGACY_STORAGE_KEYS, SVARTAKSI_STORAGE_KEYS, resetSvartaksiStorage } from '../../src/svartaksi/resetGame';
import { RENDER_OPTIONS_STORAGE_KEY } from '../../src/world/renderOptions';
import { USER_SETTINGS_STORAGE_KEY } from '../../src/svartaksi/userSettings';
import { DOG_TRUST_STORAGE_KEY } from '../../src/svartaksi/dogTrust';

function fakeStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('resetSvartaksiStorage', () => {
  it('knows every Svartaksi-owned key', () => {
    expect(SVARTAKSI_STORAGE_KEYS).toEqual(
      expect.arrayContaining([
        RENDER_OPTIONS_STORAGE_KEY,
        USER_SETTINGS_STORAGE_KEY,
        DOG_TRUST_STORAGE_KEY,
      ]),
    );
  });

  it('removes every Svartaksi-owned key and nothing else', () => {
    const storage = fakeStorage({
      [RENDER_OPTIONS_STORAGE_KEY]: '{}',
      [USER_SETTINGS_STORAGE_KEY]: '{}',
      [DOG_TRUST_STORAGE_KEY]: '{}',
      'someone-elses-key': 'untouched',
    });
    const { failed } = resetSvartaksiStorage(storage);
    expect(failed).toEqual([]);
    for (const key of SVARTAKSI_STORAGE_KEYS) expect(storage.store.has(key)).toBe(false);
    expect(storage.store.get('someone-elses-key')).toBe('untouched');
  });

  it('also removes legacy keys no longer persisted, like the retired HUD visibility key', () => {
    const storage = fakeStorage({
      'svartaksi:hud-visibility': '{}',
    });
    expect(SVARTAKSI_LEGACY_STORAGE_KEYS).toContain('svartaksi:hud-visibility');
    const { failed } = resetSvartaksiStorage(storage);
    expect(failed).toEqual([]);
    expect(storage.store.has('svartaksi:hud-visibility')).toBe(false);
  });

  it('collects failures instead of throwing on the first one', () => {
    const storage = {
      removeItem: (key: string) => {
        if (key === RENDER_OPTIONS_STORAGE_KEY) throw new Error('quota');
      },
    };
    const { failed } = resetSvartaksiStorage(storage);
    expect(failed).toEqual([RENDER_OPTIONS_STORAGE_KEY]);
  });
});
