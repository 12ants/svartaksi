import { describe, expect, it } from 'vitest';

import { sanitizeInspectionProperties } from '../../src/world/inspection';

describe('sanitizeInspectionProperties', () => {
  it('keeps only primitive values and returns keys in stable order', () => {
    expect(sanitizeInspectionProperties({
      zulu: true,
      nested: { unsafe: true },
      alpha: 3,
      empty: null,
      middle: 'road',
    })).toEqual({ alpha: 3, middle: 'road', zulu: true });
  });

  it('bounds key count, key length, and string length', () => {
    const input = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [
        `${String(index).padStart(2, '0')}-${'k'.repeat(60)}`,
        'v'.repeat(180),
      ]),
    );

    const result = sanitizeInspectionProperties(input);

    expect(Object.keys(result)).toHaveLength(16);
    expect(Object.keys(result)[0]).toHaveLength(48);
    expect(Object.values(result)[0]).toHaveLength(160);
    expect(Object.keys(result).at(-1)?.startsWith('15-')).toBe(true);
  });
});
