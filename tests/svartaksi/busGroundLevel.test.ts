import { describe, expect, it, vi } from 'vitest';

// svartaksiRuntime mounts React on import; the runtime tests stub the same module for the
// same reason. Only a constant is read here, but the import has to survive regardless.
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })) }));

import { BUS_SUSPENSION_STEP_REACH } from '../../src/svartaksi/svartaksiRuntime';
import {
  buildRoadElevationProfiles,
  roadElevationAtPoint,
  CROSSING_VERTICAL_CLEARANCE,
} from '../../src/world/roadElevationProfile';
import type { WorldRoad } from '../../src/world/types';

/** A deck crossing a street at right angles, which is the whole point of the fixture:
 * the same (x, z) has two road surfaces over it, several metres apart. */
function crossing() {
  const deck: WorldRoad = {
    id: 'span', kind: 'primary', structure: 'bridge', width: 12,
    points: [{ x: -60, z: 0 }, { x: 60, z: 0 }],
  };
  const street: WorldRoad = {
    id: 'street', kind: 'residential', width: 8,
    points: [{ x: 0, z: -60 }, { x: 0, z: 60 }],
  };
  return buildRoadElevationProfiles([deck, street]);
}

describe('bus suspension ground probes', () => {
  it('reaches a kerb-sized step without reaching a deck overhead', () => {
    // The corner probes ask for the highest road surface at or below the bus's own height
    // plus this reach. Too small and the springs stop tracking the kerbs they exist to
    // absorb; as large as a crossing's clearance and a bus driving *under* a bridge would
    // grab the deck above it and be hauled off the street it is on.
    expect(BUS_SUSPENSION_STEP_REACH).toBeGreaterThan(0.2);
    expect(BUS_SUSPENSION_STEP_REACH).toBeLessThan(CROSSING_VERTICAL_CLEARANCE);
  });

  it('answers with the street for a bus underneath and the deck for one on top', () => {
    const profiles = crossing();
    const deckHeight = roadElevationAtPoint(0, 0, profiles, 0, Infinity)!;
    expect(deckHeight).toBeGreaterThan(CROSSING_VERTICAL_CLEARANCE - 1);

    // Probing from street level: the deck is far above the cap, so it is not the surface.
    const street = roadElevationAtPoint(0, 0, profiles, 0, BUS_SUSPENSION_STEP_REACH)!;
    expect(street).toBeLessThan(1);

    // The same probe taken from the deck stays on the deck.
    expect(roadElevationAtPoint(0, 0, profiles, 0, deckHeight + BUS_SUSPENSION_STEP_REACH))
      .toBeCloseTo(deckHeight);
  });
});
