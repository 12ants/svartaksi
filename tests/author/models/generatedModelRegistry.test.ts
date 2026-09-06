import { generatedModelRegistry } from '@/author/models/generatedModelRegistry';

describe('generatedModelRegistry', () => {
  it('has the stable ordered model contract and unique basenames', () => {
    expect(generatedModelRegistry.map(({ id }) => id)).toEqual([
      'bus', 'car', 'player-pill', 'bonfire-camp',
    ]);
    expect(new Set(generatedModelRegistry.map(({ basename }) => basename)).size).toBe(4);
  });

  it.each(generatedModelRegistry)('$id creates fresh disposable groups', (entry) => {
    const first = entry.create();
    const second = entry.create();
    expect(first.root).not.toBe(second.root);
    expect(first.root.name).not.toBe('');
    expect(() => first.dispose()).not.toThrow();
    expect(() => second.dispose()).not.toThrow();
  });
});
