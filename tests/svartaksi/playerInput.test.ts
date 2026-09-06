import { describe, expect, it } from 'vitest';
import { createPlayerInputController, isBlobControlScheme } from '../../src/svartaksi/playerInput';

describe('player input controller', () => {
  it('clamps axes and merges sources by greatest absolute value', () => {
    const input = createPlayerInputController();
    input.setSourceState('keyboard', { forward: 0.6, turn: -2, boost: true });
    input.setSourceState('touch', { forward: -0.9, turn: 0.4, brake: true });
    expect(input.snapshot()).toEqual({
      forward: -0.9,
      turn: -1,
      boost: true,
      brake: true,
      lookX: 0,
      lookY: 0,
      vertical: 0,
      jump: false,
      crouch: false,
    });
  });

  it('preserves partial source updates and releases one source independently', () => {
    const input = createPlayerInputController();
    input.setSourceState('touch', { forward: 1, turn: 0.5 });
    input.setSourceState('touch', { boost: true });
    expect(input.snapshot()).toMatchObject({ forward: 1, turn: 0.5, boost: true });
    input.releaseSource('touch');
    expect(input.snapshot()).toMatchObject({ forward: 0, turn: 0, boost: false });
  });

  it('returns snapshots that callers cannot mutate', () => {
    const input = createPlayerInputController();
    input.setSourceState('keyboard', { forward: 1 });
    input.snapshot().forward = 0;
    expect(input.snapshot().forward).toBe(1);
  });
});

describe('isBlobControlScheme', () => {
  it('accepts only the two known schemes', () => {
    expect(isBlobControlScheme('direct')).toBe(true);
    expect(isBlobControlScheme('blobby')).toBe(true);
  });

  it('rejects anything else, including values from a build that no longer has them', () => {
    expect(isBlobControlScheme('orbit')).toBe(false);
    expect(isBlobControlScheme('')).toBe(false);
    expect(isBlobControlScheme(null)).toBe(false);
    expect(isBlobControlScheme(undefined)).toBe(false);
    expect(isBlobControlScheme(42)).toBe(false);
  });
});
