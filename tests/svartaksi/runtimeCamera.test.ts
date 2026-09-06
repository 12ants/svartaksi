import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import {
  createCameraTransformApplier,
  updateCameraFov,
} from '../../src/svartaksi/runtimeCamera';

describe('createCameraTransformApplier', () => {
  it('eases position and orientation toward the requested shot', () => {
    const camera = new THREE.PerspectiveCamera();
    const applyTransform = createCameraTransformApplier();

    applyTransform(
      camera,
      new THREE.Vector3(8, 4, -2),
      new THREE.Vector3(18, 4, -2),
      0.5,
    );

    expect(camera.position.toArray()).toEqual([4, 2, -1]);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    expect(direction.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(direction.y).toBeCloseTo(0, 12);
    expect(direction.z).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('keeps separate appliers isolated during nested updates', () => {
    const firstCamera = new THREE.PerspectiveCamera();
    const secondCamera = new THREE.PerspectiveCamera();
    const applyFirst = createCameraTransformApplier();
    const applySecond = createCameraTransformApplier();
    const firstLerp = firstCamera.position.lerp.bind(firstCamera.position);

    firstCamera.position.lerp = (target, blend) => {
      applySecond(
        secondCamera,
        new THREE.Vector3(0, 0, 5),
        new THREE.Vector3(-10, 0, 5),
        1,
      );
      return firstLerp(target, blend);
    };

    applyFirst(
      firstCamera,
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(10, 0, 5),
      1,
    );

    const firstDirection = firstCamera.getWorldDirection(new THREE.Vector3());
    const secondDirection = secondCamera.getWorldDirection(new THREE.Vector3());
    expect(firstDirection.x).toBeCloseTo(1, 12);
    expect(firstDirection.y).toBeCloseTo(0, 12);
    expect(firstDirection.z).toBeCloseTo(0, 12);
    expect(secondDirection.x).toBeCloseTo(-1, 12);
    expect(secondDirection.y).toBeCloseTo(0, 12);
    expect(secondDirection.z).toBeCloseTo(0, 12);
  });
});

describe('updateCameraFov', () => {
  it('updates a perspective projection once when the requested FOV changes', () => {
    const camera = new THREE.PerspectiveCamera(48);
    const updateProjectionMatrix = vi.spyOn(camera, 'updateProjectionMatrix');

    updateCameraFov(camera, 70);
    updateCameraFov(camera, 70);

    expect(camera.fov).toBe(70);
    expect(updateProjectionMatrix).toHaveBeenCalledTimes(1);
  });

  it('leaves non-perspective cameras unchanged', () => {
    const camera = new THREE.OrthographicCamera();
    const updateProjectionMatrix = vi.spyOn(camera, 'updateProjectionMatrix');

    updateCameraFov(camera, 70);

    expect(updateProjectionMatrix).not.toHaveBeenCalled();
  });
});
