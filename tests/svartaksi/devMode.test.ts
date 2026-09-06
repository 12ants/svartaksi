import { describe, expect, it } from 'vitest';
import { isDevModeRequested } from '../../src/svartaksi/devMode';
describe('unified game URL', () => {
  it('offers the same controls on standard and legacy URLs', () => {
    for (const query of ['', '?other=1', '?dev=1', '?dev=0']) expect(isDevModeRequested(query)).toBe(true);
  });
});
