import { describe, expect, it } from 'vitest';

import {
  FACADE_PALETTES,
  classifyFacadeArea,
  resolveFacadeColors,
  stableFacadeVariant,
} from '../../src/svartaksi/facadePalette';

describe('facade palettes', () => {
  it('contains the exact eight planned colors for all four schemes', () => {
    expect(FACADE_PALETTES).toEqual({
      'stockholm-dusk': {
        residential: '#6F655D', commercial: '#755C55', office: '#566473', store: '#8B4A3D',
        industrial: '#665B50', litWindow: '#FFD98A', doorAccent: '#9A603F', pavement: '#77736C',
      },
      'nordic-day': {
        residential: '#D8D3C8', commercial: '#C9B8A5', office: '#A9BBC8', store: '#D9855F',
        industrial: '#B6B1A7', litWindow: '#FFF2C2', doorAccent: '#76523C', pavement: '#C8C5BD',
      },
      'night-noir': {
        residential: '#2B2E33', commercial: '#342F32', office: '#202A35', store: '#4A2A28',
        industrial: '#35312D', litWindow: '#D7E8FF', doorAccent: '#7A5848', pavement: '#414349',
      },
      'high-contrast': {
        residential: '#737373', commercial: '#806A54', office: '#3F607A', store: '#B5502E',
        industrial: '#6B624D', litWindow: '#FFF59D', doorAccent: '#E69F00', pavement: '#B5B5B5',
      },
    });
  });

  it('selects all three variants deterministically without random state', () => {
    const first = stableFacadeVariant('building-a', 'gamla-stan', 'stockholm-dusk');
    expect(stableFacadeVariant('building-a', 'gamla-stan', 'stockholm-dusk')).toBe(first);
    const variants = new Set(
      Array.from({ length: 100 }, (_, index) =>
        stableFacadeVariant(`building-${index}`, 'gamla-stan', 'stockholm-dusk')),
    );
    expect([...variants].sort()).toEqual([0, 1, 2]);
  });

  it('normalizes available place context into the bounded area vocabulary', () => {
    expect(classifyFacadeArea('Gamla Stan', [])).toBe('historic');
    expect(classifyFacadeArea('', ['landuse: industrial'])).toBe('industrial');
    expect(classifyFacadeArea('', ['poi: shopping centre'])).toBe('commercial');
    expect(classifyFacadeArea('', [])).toBe('unknown');
  });

  it('keeps high-contrast colors bounded while varying other schemes', () => {
    const base = resolveFacadeColors('high-contrast', 'office', 1, 'unknown');
    const shifted = resolveFacadeColors('high-contrast', 'office', 2, 'historic');
    expect(base.windowColor).toBe('#FFF59D');
    expect(shifted.wallColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(shifted.doorColor).toBe('#E69F00');
  });
});
