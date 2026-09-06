import { describe, expect, it } from 'vitest';
import { attachEntrancesToBuildings } from '../../src/world/buildingEntrances';
import type { WorldData } from '../../src/world/types';

const building = (id: string, x: number) => ({
  id, height: 10, properties: {},
  rings: [[{ x, z: 0 }, { x: x + 10, z: 0 }, { x: x + 10, z: 10 }, { x, z: 10 }]],
});

describe('building entrances', () => {
  it('attaches an entrance to the nearest wall within three meters', () => {
    const data: WorldData = {
      source: 'maplibre', roads: [], water: [], parks: [], labels: [],
      buildings: [building('near', 0), building('farther', 12)],
      objects: [{ id: 'door', kind: 'entrance', point: { x: 10.4, z: 5 }, properties: { entrance: 'yes' } }],
    };
    const attached = attachEntrancesToBuildings(data);
    expect(attached.buildings[0].entrances).toHaveLength(1);
    expect(attached.buildings[1].entrances).toBeUndefined();
  });

  it('leaves distant entrances unattached', () => {
    const data: WorldData = {
      source: 'maplibre', roads: [], water: [], parks: [], labels: [],
      buildings: [building('only', 0)],
      objects: [{ id: 'door', kind: 'entrance', point: { x: 30, z: 30 }, properties: {} }],
    };
    expect(attachEntrancesToBuildings(data).buildings[0].entrances).toBeUndefined();
  });
});
