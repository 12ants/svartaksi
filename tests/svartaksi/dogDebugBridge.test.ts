import { describe, expect, it, vi } from 'vitest';

import { installDogDebugBridge, isDogDebugRequested } from '../../src/svartaksi/dogDebugBridge';

function fakeWindow() {
  return {} as Window & { __SVARTAKSI_DOG__?: unknown };
}

describe('isDogDebugRequested', () => {
  it('is available on standard and legacy URLs', () => {
    expect(isDogDebugRequested('?dev=1')).toBe(true);
    expect(isDogDebugRequested('')).toBe(true);
    expect(isDogDebugRequested('?dev=0')).toBe(true);
    expect(isDogDebugRequested('?perfCapture=1')).toBe(true);
  });
});

describe('installDogDebugBridge', () => {
  it('installs a working bridge on the standard URL', () => {
    const target = fakeWindow();
    const dispose = installDogDebugBridge({ target, search: '', read: () => null });
    expect(dispose).toBeTypeOf('function');
    expect(target.__SVARTAKSI_DOG__?.get()).toBeNull();
    dispose!();
  });

  it('installs a bridge that proxies through to the injected read function', () => {
    const target = fakeWindow();
    const read = vi.fn(() => ({ x: 1, z: 2, behavior: 'stalking' as const, trust: 0 }));
    void installDogDebugBridge({ target, search: '?dev=1', read });
    expect(target.__SVARTAKSI_DOG__?.schemaVersion).toBe(1);
    expect(target.__SVARTAKSI_DOG__?.get()).toEqual({ x: 1, z: 2, behavior: 'stalking', trust: 0 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('removes the global on dispose', () => {
    const target = fakeWindow();
    const dispose = installDogDebugBridge({ target, search: '?dev=1', read: () => null });
    expect(dispose).toBeTruthy();
    dispose!();
    expect(target.__SVARTAKSI_DOG__).toBeUndefined();
  });
});
