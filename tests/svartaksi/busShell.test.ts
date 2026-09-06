import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  assembleBusShell,
  BUS_ASSET_SIZE,
  busShellScale,
  createBusShell,
  setLampIntensity,
} from '@/svartaksi/busShell';
import {
  applyBusShell,
  BUS_SHELL_MESH_NAMES,
  createBusModel,
  isBusShellPart,
  revealProceduralBusShell,
  setBusSteer,
  setBusWheelRoll,
  setBusWheelTravel,
} from '@/svartaksi/busModel';
import { BUS_DIMENSIONS, computeAckermannAngles } from '@/svartaksi/busGeometry';
import { BUS_SHELL_WHEEL_HUBS, type BusShellWheel } from '@/svartaksi/busShellWheels';

/** Synthetic fixtures exercise layout and ownership, not bus1.glb's exact topology. */
const TEST_WHEEL_HUBS = BUS_SHELL_WHEEL_HUBS.map((hub) => ({
  x: hub.x, y: hub.y, z: hub.z, radius: hub.radius, halfWidth: hub.halfWidth,
  front: hub.front, side: hub.side, suspensionIndex: hub.suspensionIndex,
}));

/** A wheel with no geometry: enough for the binding, nothing for a renderer to want. */
function stubWheel(
  restCenter: [number, number, number],
  options: { front: boolean; side: 1 | -1; suspensionIndex: number },
): BusShellWheel {
  const steer = new THREE.Group();
  const roll = new THREE.Group();
  steer.add(roll);
  steer.position.set(...restCenter);
  return { steer, roll, restCenter: new THREE.Vector3(...restCenter), ...options };
}

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

describe('the modelled shell\'s wheels', () => {
  const frontLeft = () => stubWheel([1.1, 0.45, 2.9], { front: true, side: 1, suspensionIndex: 4 });
  const rearRight = () => stubWheel([-1.1, 0.45, -2.6], { front: false, side: -1, suspensionIndex: 0 });

  it('turns, rolls and springs from the setters that already drive the procedural ones', () => {
    const model = createBusModel();
    try {
      const wheels = [frontLeft(), rearRight()];
      applyBusShell(model, { group: new THREE.Group(), wheels });

      setBusSteer(model, 0.1);
      setBusWheelRoll(model, 1.2);
      setBusWheelTravel(model, [0.03, 0, 0, 0, 0.05, 0]);

      const { left } = computeAckermannAngles(0.1, BUS_DIMENSIONS.wheelbase, BUS_DIMENSIONS.track);
      expect(wheels[0].steer.rotation.y).toBeCloseTo(left);
      expect(wheels[1].steer.rotation.y).toBe(0);
      expect(wheels[0].roll.rotation.x).toBeCloseTo(1.2);
      expect(wheels[1].roll.rotation.x).toBeCloseTo(1.2);
      expect(wheels[0].steer.position.y).toBeCloseTo(0.45 + 0.05);
      expect(wheels[1].steer.position.y).toBeCloseTo(0.45 + 0.03);

      // The procedural groups keep moving too, so the fallback stays usable.
      expect(model.frontWheels[0].rotation.y).toBeCloseTo(left);
      expect(model.wheelRoll[0].rotation.x).toBeCloseTo(1.2);
    } finally {
      model.dispose();
    }
  });

  it('catches the wheels up the moment a shell arrives mid-ride', () => {
    const model = createBusModel();
    try {
      setBusSteer(model, -0.08);
      setBusWheelRoll(model, 4);
      setBusWheelTravel(model, [0, 0, 0, 0, -0.02, 0]);

      const wheels = [frontLeft()];
      applyBusShell(model, { group: new THREE.Group(), wheels });

      const { left } = computeAckermannAngles(-0.08, BUS_DIMENSIONS.wheelbase, BUS_DIMENSIONS.track);
      expect(wheels[0].steer.rotation.y).toBeCloseTo(left);
      expect(wheels[0].roll.rotation.x).toBeCloseTo(4);
      expect(wheels[0].steer.position.y).toBeCloseTo(0.45 - 0.02);
    } finally {
      model.dispose();
    }
  });

  it('accepts a shell that brought no wheels, as the tests and a re-export both may', () => {
    const model = createBusModel();
    try {
      expect(() => applyBusShell(model, { group: new THREE.Group() })).not.toThrow();
      expect(() => setBusSteer(model, 0.2)).not.toThrow();
      expect(() => setBusWheelRoll(model, 1)).not.toThrow();
      expect(() => setBusWheelTravel(model, [0, 0, 0, 0, 0, 0])).not.toThrow();
    } finally {
      model.dispose();
    }
  });
});

describe('assembleBusShell', () => {
  /** A ring about the X axis, one connected component, centred on `hub`. */
  function wheelBand(hub: { x: number; y: number; z: number }, radius: number, halfWidth: number): number[] {
    const positions: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const [a, b] = [(i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2];
      const ring = (angle: number, x: number) => [x, hub.y + Math.cos(angle) * radius, hub.z + Math.sin(angle) * radius];
      positions.push(
        ...ring(a, hub.x - halfWidth), ...ring(b, hub.x - halfWidth), ...ring(a, hub.x + halfWidth),
        ...ring(b, hub.x - halfWidth), ...ring(b, hub.x + halfWidth), ...ring(a, hub.x + halfWidth),
      );
    }
    return positions;
  }

  /** A stand-in asset carrying one wheel at each of the four measured hubs. */
  function fakeAsset(): THREE.Object3D {
    const hubs = [
      { x: -1.0936, y: 0.4654, z: -2.4555 },
      { x: 1.0933, y: 0.4654, z: -2.4555 },
      { x: -1.0936, y: 0.4654, z: 2.7164 },
      { x: 1.0933, y: 0.4654, z: 2.7164 },
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(
      hubs.flatMap((hub) => wheelBand(hub, 0.4, 0.15)),
    ), 3));
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    return root;
  }

  it('keeps the fit scale off the wheels, so a steered wheel cannot shear', () => {
    const scale = busShellScale();

    const { group, wheels } = assembleBusShell(fakeAsset(), scale, TEST_WHEEL_HUBS);

    // The scale lives on the body, not on the shell root the wheels also hang from.
    expect(group.scale.equals(new THREE.Vector3(1, 1, 1))).toBe(true);
    const body = group.children.find((child) => child.name === 'bus:shell-body');
    expect(body?.scale.toArray()).toEqual(scale.toArray());

    group.updateMatrixWorld(true);
    for (const wheel of wheels) {
      const worldScale = new THREE.Vector3();
      wheel.roll.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
      expect(worldScale.x).toBeCloseTo(1, 6);
      expect(worldScale.y).toBeCloseTo(1, 6);
      expect(worldScale.z).toBeCloseTo(1, 6);
    }
  });

  it('shows the authored wheels and hides the procedural ones, so the bus has four not ten', () => {
    const model = createBusModel();
    try {
      const shell = assembleBusShell(fakeAsset(), busShellScale(), TEST_WHEEL_HUBS);
      applyBusShell(model, shell);

      for (const wheel of shell.wheels) {
        // Visible all the way up: a wheel parented under something hidden would be an
        // animation nobody can see, which is the regression this whole task exists to fix.
        for (let node: THREE.Object3D | null = wheel.steer; node; node = node.parent) {
          expect(node.visible).toBe(true);
        }
      }
      for (const group of [...model.frontWheels, ...model.wheelRoll]) {
        let hidden = false;
        for (let node: THREE.Object3D | null = group; node; node = node.parent) {
          if (!node.visible) hidden = true;
        }
        expect(hidden).toBe(true);
      }
    } finally {
      model.dispose();
    }
  });

  it('puts each wheel on the sheet, not in the asset\'s own unscaled space', () => {
    const scale = busShellScale();

    const { wheels } = assembleBusShell(fakeAsset(), scale, TEST_WHEEL_HUBS);

    expect(wheels).toHaveLength(4);
    const frontLeft = wheels.find((wheel) => wheel.front && wheel.side === 1)!;
    expect(frontLeft.restCenter.x).toBeCloseTo(1.0933 * scale.x, 3);
    expect(frontLeft.restCenter.y).toBeCloseTo(0.4654 * scale.y, 3);
    expect(frontLeft.restCenter.z).toBeCloseTo(2.7164 * scale.z, 3);
    expect(frontLeft.suspensionIndex).toBe(4);
  });
});

describe('bus shell resource ownership', () => {
  /**
   * A stand-in for what the loader hands back: an interior nobody keeps, an exterior that
   * shares the interior's material, and the running gear the split takes apart.
   */
  function loadedScene() {
    const shared = new THREE.MeshStandardMaterial({ name: 'body' });
    const wheelMaterial = new THREE.MeshStandardMaterial({ name: 'wheel' });
    const interiorMaterial = new THREE.MeshStandardMaterial({ name: 'interior' });
    const interiorGeometry = new THREE.BoxGeometry(1, 1, 1);
    const exteriorGeometry = new THREE.BoxGeometry(2, 2, 2);

    const hubs = [
      { x: -1.0936, y: 0.4654, z: -2.4555 },
      { x: 1.0933, y: 0.4654, z: -2.4555 },
      { x: -1.0936, y: 0.4654, z: 2.7164 },
      { x: 1.0933, y: 0.4654, z: 2.7164 },
    ];
    const positions: number[] = [];
    for (const hub of hubs) {
      for (let i = 0; i < 8; i += 1) {
        const [a, b] = [(i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2];
        const ring = (angle: number, x: number) => [
          x, hub.y + Math.cos(angle) * 0.4, hub.z + Math.sin(angle) * 0.4,
        ];
        positions.push(
          ...ring(a, hub.x - 0.15), ...ring(b, hub.x - 0.15), ...ring(a, hub.x + 0.15),
          ...ring(b, hub.x - 0.15), ...ring(b, hub.x + 0.15), ...ring(a, hub.x + 0.15),
        );
      }
    }
    const wheelGeometry = new THREE.BufferGeometry();
    wheelGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

    const root = new THREE.Group();
    // The interior is identified by one material and also uses the body's paint. This is
    // the dangerous case: releasing materials while dropping the interior would dispose
    // `shared` out from under the retained exterior.
    const interior = new THREE.Mesh(interiorGeometry, [interiorMaterial, shared]);
    root.add(interior, new THREE.Mesh(exteriorGeometry, shared), new THREE.Mesh(wheelGeometry, wheelMaterial));

    const spies = new Map<string, ReturnType<typeof vi.spyOn>>();
    const watch = (name: string, resource: { dispose: () => void }) => {
      spies.set(name, vi.spyOn(resource, 'dispose'));
    };
    watch('interiorGeometry', interiorGeometry);
    watch('exteriorGeometry', exteriorGeometry);
    watch('wheelGeometry', wheelGeometry);
    watch('shared', shared);
    watch('wheelMaterial', wheelMaterial);
    watch('interiorMaterial', interiorMaterial);

    return { root, spies, shared, interiorGeometry };
  }

  it('keeps a material the body still uses alive when the interior is dropped', () => {
    const { root, spies } = loadedScene();

    const shell = createBusShell(root, TEST_WHEEL_HUBS);

    // Nothing is released while the shell is being built: the interior is detached, not
    // destroyed, and a material it happened to share would still be on the body.
    for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
    expect(shell.group.getObjectByName('bus:shell-body')).toBeDefined();
  });

  it('releases the detached interior, the retained body and the split wheels exactly once', () => {
    const { root, spies } = loadedScene();
    const shell = createBusShell(root, TEST_WHEEL_HUBS);
    const created: THREE.BufferGeometry[] = [];
    for (const wheel of shell.wheels) {
      wheel.roll.traverse((object) => { if (object instanceof THREE.Mesh) created.push(object.geometry); });
    }
    const createdSpies = created.map((geometry) => vi.spyOn(geometry, 'dispose'));

    shell.dispose();

    // The interior is no longer in the scene, and the wheel source mesh was emptied out
    // of it, so neither is reachable by traversal — both are still owned.
    for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(1);
    for (const spy of createdSpies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is inert when disposed twice', () => {
    const { root, spies } = loadedScene();
    const shell = createBusShell(root, TEST_WHEEL_HUBS);

    shell.dispose();
    shell.dispose();
    shell.dispose();

    for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(1);
  });

  it('releases every imported resource when wheel validation rejects the asset', () => {
    const { root, spies } = loadedScene();
    const impossibleHubs = [
      ...TEST_WHEEL_HUBS,
      {
        x: 10, y: 10, z: 10, radius: 0.4, halfWidth: 0.2,
        front: true, side: 1 as const, suspensionIndex: 4,
      },
    ];

    expect(() => createBusShell(root, impossibleHubs)).toThrow(/no geometry/i);

    for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(1);
  });

  it('releases everything when the load lands after the runtime is gone', () => {
    const { root, spies } = loadedScene();

    // The runtime's `.then` disposes a shell it never attached; nothing else ever will.
    const shell = createBusShell(root, TEST_WHEEL_HUBS);
    shell.dispose();

    for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(1);
    expect(shell.group.parent).toBeNull();
  });

  it('leaves the shell to its own owner when the bus model is disposed', () => {
    const { root, spies } = loadedScene();
    const shell = createBusShell(root, TEST_WHEEL_HUBS);
    const model = createBusModel();
    applyBusShell(model, shell);

    model.dispose();

    // The bus disposes the procedural body it built and nothing the shell brought: two
    // owners traversing one tree is how a shared material gets disposed out from under a
    // live mesh.
    for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
    expect(shell.group.parent).toBeNull();

    shell.dispose();
    for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(1);
  });
});
