import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLog, getLog, installConsoleCapture, pushLog, subscribe } from '../../src/svartaksi/gameLogger';

describe('gameLogger', () => {
  beforeEach(() => clearLog());

  it('pushes entries with an incrementing id and the given level/category/message', () => {
    pushLog('info', 'mode', 'now car');
    pushLog('warn', 'world', 'streaming: slow tile');
    const log = getLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ level: 'info', category: 'mode', message: 'now car' });
    expect(log[1]).toMatchObject({ level: 'warn', category: 'world', message: 'streaming: slow tile' });
    expect(log[1].id).toBeGreaterThan(log[0].id);
  });

  it('returns a new array reference from getLog after each push, so useSyncExternalStore can detect changes', () => {
    const before = getLog();
    pushLog('info', 'test', 'one');
    const after = getLog();
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
  });

  it('caps the buffer at 500 entries, evicting the oldest first', () => {
    for (let i = 0; i < 505; i += 1) pushLog('info', 'test', `entry ${i}`);
    const log = getLog();
    expect(log).toHaveLength(500);
    expect(log[0].message).toBe('entry 5');
    expect(log[499].message).toBe('entry 504');
  });

  it('clearLog empties the buffer', () => {
    pushLog('info', 'test', 'one');
    clearLog();
    expect(getLog()).toHaveLength(0);
  });

  it('notifies subscribers on push and on clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    pushLog('info', 'test', 'one');
    expect(listener).toHaveBeenCalledTimes(1);
    clearLog();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    pushLog('info', 'test', 'two');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe('installConsoleCapture', () => {
    let originalWarn: typeof console.warn;
    let originalError: typeof console.error;

    beforeEach(() => {
      originalWarn = console.warn;
      originalError = console.error;
    });

    afterEach(() => {
      console.warn = originalWarn;
      console.error = originalError;
    });

    it('mirrors console.warn/console.error into the log and still calls the original', () => {
      const warnSpy = vi.fn();
      const errorSpy = vi.fn();
      console.warn = warnSpy;
      console.error = errorSpy;

      const dispose = installConsoleCapture();
      console.warn('careful', 42);
      console.error('broken');

      const log = getLog();
      expect(log).toHaveLength(2);
      expect(log[0]).toMatchObject({ level: 'warn', category: 'console' });
      expect(log[0].message).toContain('careful');
      expect(log[1]).toMatchObject({ level: 'error', category: 'console', message: 'broken' });
      expect(warnSpy).toHaveBeenCalledWith('careful', 42);
      expect(errorSpy).toHaveBeenCalledWith('broken');

      dispose();
      console.warn('after dispose');
      expect(getLog()).toHaveLength(2);
    });

    it('is a no-op the second time until the first capture is disposed', () => {
      const dispose1 = installConsoleCapture();
      const wrappedWarn = console.warn;
      const dispose2 = installConsoleCapture();
      expect(console.warn).toBe(wrappedWarn);
      dispose2();
      dispose1();
    });
  });
});
