import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOverlayController } from '../../src/hooks/useOverlayController';

describe('useOverlayController', () => {
  it('keeps one overlay open, releases input, and restores trigger focus', () => {
    const releaseInput = vi.fn();
    const first = document.createElement('button');
    const second = document.createElement('button');
    document.body.append(first, second);
    const { result } = renderHook(() => useOverlayController(releaseInput));

    act(() => result.current.open('world', first));
    expect(result.current.activeOverlay).toBe('world');
    act(() => result.current.open('map', second));
    expect(result.current.activeOverlay).toBe('map');
    expect(releaseInput).toHaveBeenCalledTimes(2);
    act(() => result.current.close());
    expect(document.activeElement).toBe(second);
    first.remove();
    second.remove();
  });

  it('closes the top overlay on Escape', () => {
    const { result } = renderHook(() => useOverlayController(vi.fn()));
    act(() => result.current.open('hud'));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(result.current.activeOverlay).toBeNull();
  });
});
