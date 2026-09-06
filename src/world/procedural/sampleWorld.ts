import type { WorldData } from '../types';

export const PROCEDURAL_SAMPLE_WORLD: WorldData = {
  source: 'maplibre',
  roads: [
    { id: 'road-primary', kind: 'primary', width: 9, points: [{ x: -90, z: 0 }, { x: 90, z: 0 }] },
    { id: 'road-residential', kind: 'residential', width: 5, points: [{ x: 0, z: -80 }, { x: 0, z: 80 }] },
  ],
  buildings: [
    { id: 'house', height: 9, rings: [[{ x: -45, z: 15 }, { x: -20, z: 15 }, { x: -20, z: 38 }, { x: -45, z: 38 }]], properties: { building: 'house' }, appearance: { buildingKind: 'house', wallColor: '#b7b7b2', roofColor: '#333333', levels: 2 } },
    { id: 'shop', height: 14, rings: [[{ x: 18, z: 14 }, { x: 52, z: 14 }, { x: 52, z: 42 }, { x: 18, z: 42 }]], properties: { building: 'commercial', shop: 'convenience' }, appearance: { buildingUse: 'commercial', wallColor: '#888888', levels: 3 }, entrances: [{ point: { x: 35, z: 14 }, tags: { entrance: 'main' } }] },
    { id: 'tower', height: 32, rings: [[{ x: 22, z: -48 }, { x: 48, z: -48 }, { x: 48, z: -22 }, { x: 22, z: -22 }]], properties: { building: 'apartments' }, appearance: { buildingUse: 'apartments', levels: 9 } },
  ],
  water: [{ id: 'water', kind: 'water', rings: [[{ x: -100, z: -100 }, { x: -60, z: -100 }, { x: -60, z: 100 }, { x: -100, z: 100 }]] }],
  parks: [{ id: 'park', kind: 'park', rings: [[{ x: 58, z: -65 }, { x: 100, z: -65 }, { x: 100, z: 65 }, { x: 58, z: 65 }]] }],
  labels: [{ id: 'label', text: 'SAMPLE STREET', point: { x: 4, z: 4 }, category: 'road' }],
  objects: [
    { id: 'tree-1', kind: 'tree', point: { x: 68, z: -30 }, properties: { species: 'birch' } },
    { id: 'tree-2', kind: 'tree', point: { x: 78, z: 5 }, properties: { species: 'pine' } },
    { id: 'lamp', kind: 'street_lamp', point: { x: -12, z: 7 }, properties: {} },
    { id: 'bench', kind: 'bench', point: { x: 65, z: 28 }, properties: {} },
    { id: 'post-box', kind: 'post_box', point: { x: -8, z: 15 }, properties: {} },
    { id: 'shop-poi', kind: 'shop', point: { x: 35, z: 16 }, properties: { name: 'Sample shop' } },
  ],
};
