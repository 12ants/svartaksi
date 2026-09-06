import { describe, expect, it } from 'vitest';
import { LOADING_VERSES, pickLoadingVerse } from '../../src/svartaksi/loadingPoetry';

describe('loading poetry', () => {
  it('offers a set of short, titled verses', () => {
    expect(LOADING_VERSES.length).toBeGreaterThan(8);
    for (const verse of LOADING_VERSES) {
      expect(verse.title).not.toBe('');
      expect(verse.lines.length).toBeGreaterThanOrEqual(2);
      expect(verse.lines.length).toBeLessThanOrEqual(4);
      for (const line of verse.lines) expect(line.trim()).not.toBe('');
    }
  });

  it('has unique titles, so React can key on them', () => {
    expect(new Set(LOADING_VERSES.map((verse) => verse.title)).size).toBe(LOADING_VERSES.length);
  });

  it('maps the whole 0..1 seed range across the set, endpoints included', () => {
    expect(pickLoadingVerse(0)).toBe(LOADING_VERSES[0]);
    expect(pickLoadingVerse(0.999999)).toBe(LOADING_VERSES[LOADING_VERSES.length - 1]);
    const reached = new Set(
      Array.from({ length: 200 }, (_, index) => pickLoadingVerse(index / 200).title),
    );
    expect(reached.size).toBe(LOADING_VERSES.length);
  });

  it('survives a seed outside 0..1 rather than indexing off the end', () => {
    for (const seed of [1, 4.5, -0.25, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(LOADING_VERSES).toContain(pickLoadingVerse(seed));
    }
  });
});
