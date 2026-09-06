import type * as THREE from 'three';
import { createBonfireCamp } from '@/svartaksi/bonfireModel';
import { campLayout } from '@/svartaksi/bonfireCamp';
import { createBusModel } from '@/svartaksi/busModel';
import { createCarModel } from '@/svartaksi/carModel';
import { createPersonModel } from '@/svartaksi/personModel';
import { disposeObject3D } from './disposeObject3D';

export interface GeneratedModelInstance {
  root: THREE.Group;
  dispose(): void;
}

export interface GeneratedModelEntry {
  id: 'bus' | 'car' | 'player-pill' | 'bonfire-camp';
  label: string;
  basename: string;
  create(): GeneratedModelInstance;
}

export const generatedModelRegistry: readonly GeneratedModelEntry[] = [
  {
    id: 'bus', label: 'Bus', basename: 'svartaksi-bus',
    create: () => {
      const model = createBusModel();
      return { root: model.group, dispose: model.dispose };
    },
  },
  {
    id: 'car', label: 'Car', basename: 'svartaksi-car',
    create: () => {
      const model = createCarModel();
      return { root: model.group, dispose: () => disposeObject3D(model.group) };
    },
  },
  {
    id: 'player-pill', label: 'Player pill', basename: 'svartaksi-player-pill',
    create: () => {
      const model = createPersonModel();
      return { root: model.group, dispose: () => disposeObject3D(model.group) };
    },
  },
  {
    id: 'bonfire-camp', label: 'Bonfire camp', basename: 'svartaksi-bonfire-camp',
    create: () => {
      const model = createBonfireCamp(campLayout());
      return { root: model.group, dispose: model.dispose };
    },
  },
];
