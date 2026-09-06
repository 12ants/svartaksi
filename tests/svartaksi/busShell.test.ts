import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BUS_ASSET_SIZE, busShellScale, setLampIntensity } from '@/svartaksi/busShell';
import {
  applyBusShell,
  BUS_SHELL_MESH_NAMES,
  createBusModel,
  isBusShellPart,
  revealProceduralBusShell,
} from '@/svartaksi/busModel';
import { BUS_DIMENSIONS } from '@/svartaksi/busGeometry';

describe('busShellScale', () => {
  it('puts the asset on the approved dimension sheet in every axis', () => {
    const scale = busShellScale();

    expect(BUS_ASSET_SIZE.width * scale.x).toBeCloseTo(BUS_DIMENSIONS.width, 5);
    expect(BUS_ASSET_SIZE.height * scale.y).toBeCloseTo(BUS_DIMENSIONS.height, 5);
    expect(BUS_ASSET_SIZE.length * scale.z).toBeCloseTo(BUS_DIMENSIONS.length, 5);
  });

  it('distorts the asset by less than a tenth in any axis', () => {
    const scale = busShellScale();

    for (const axis of [scale.x, scale.y, scale.z]) {
      expect(Math.abs(axis - 1)).toBeLessThan(0.1);
    }
  });
});

describe('isBusShellPart', () => {
  it('claims the skin and the running gear, and nothing the player rides inside', () => {
    expect(isBusShellPart('bus:body-roof')).toBe(true);
    expect(isBusShellPart('bus:left-windows')).toBe(true);
    expect(isBusShellPart('bus:wheel-rear-outer-1-axle')).toBe(true);
    expect(isBusShellPart('bus:front-wheel-left')).toBe(true);
    expect(isBusShellPart('bus:valance-1--5.3')).toBe(true);

    expect(isBusShellPart('bus:floor')).toBe(false);
    expect(isBusShellPart('bus:door')).toBe(false);
    expect(isBusShellPart('bus:seat-cushion-0-0.88')).toBe(false);
    expect(isBusShellPart('bus:driver-console')).toBe(false);
    expect(isBusShellPart('bus:steering-wheel')).toBe(false);
  });
});

describe('swapping the modelled shell in', () => {
  it('names only panels the bus actually has — the list cannot silently rot', () => {
    const model = createBusModel();
    try {
      const built = new Set(model.group.children.map((child) => child.name));
      for (const name of BUS_SHELL_MESH_NAMES) expect(built).toContain(name);
    } finally {
      model.dispose();
    }
  });

  it('hides the procedural skin and keeps everything the gameplay needs', () => {
    const model = createBusModel();
    try {
      const shell = new THREE.Group();
      shell.name = 'bus:shell';

      applyBusShell(model, { group: shell });

      const hidden = model.group.children.filter((child) => !child.visible).map((child) => child.name);
      expect(hidden).toEqual(expect.arrayContaining([...BUS_SHELL_MESH_NAMES]));
      expect(hidden.every((name) => isBusShellPart(name))).toBe(true);

      expect(model.door.visible).toBe(true);
      expect(model.group.getObjectByName('bus:floor')?.visible).toBe(true);
      expect(model.group.getObjectByName('bus:shell')).toBe(shell);
    } finally {
      model.dispose();
    }
  });

  it('can be undone, for a session that could not fetch the asset', () => {
    const model = createBusModel();
    try {
      applyBusShell(model, { group: new THREE.Group() });
      revealProceduralBusShell(model);

      expect(model.group.children.filter((child) => isBusShellPart(child.name))
        .every((child) => child.visible)).toBe(true);
    } finally {
      model.dispose();
    }
  });

  it('keeps the steering and roll groups reachable, so hiding them cannot crash a frame', () => {
    const model = createBusModel();
    try {
      applyBusShell(model, { group: new THREE.Group() });

      for (const wheel of [...model.frontWheels, ...model.wheelRoll]) {
        expect(wheel.parent).not.toBeNull();
      }
    } finally {
      model.dispose();
    }
  });
});

describe('setLampIntensity', () => {
  it('drives a lamp the asset has, and shrugs at one it does not', () => {
    const material = new THREE.MeshStandardMaterial();

    setLampIntensity(material, 1.4);
    expect(material.emissiveIntensity).toBe(1.4);

    setLampIntensity(material, -1);
    expect(material.emissiveIntensity).toBe(0);

    expect(() => setLampIntensity(null, 1)).not.toThrow();
  });
});
