import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useHudVisibility } from '../../src/hooks/useHudVisibility';

describe('useHudVisibility', () => {
  it('always boots fully hidden, regardless of prior state', () => {
    const { result } = renderHook(() => useHudVisibility());
    expect(result.current.visibility).toEqual({
      status: false,
      actions: false,
      context: false,
      controls: false,
    });
  });

  it('toggleAll restores full visibility from a zen boot, then hides again', () => {
    const { result } = renderHook(() => useHudVisibility());
    act(() => result.current.toggleAll());
    expect(result.current.visibility).toEqual({
      status: true,
      actions: true,
      context: true,
      controls: true,
    });
    act(() => result.current.toggleAll());
    expect(Object.values(result.current.visibility).every((visible) => !visible)).toBe(true);
  });

  it('setRegion updates a single region without touching the others', () => {
    const { result } = renderHook(() => useHudVisibility());
    act(() => result.current.toggleAll());
    act(() => result.current.setRegion('context', false));
    expect(result.current.visibility).toMatchObject({ context: false, status: true });
  });
});
