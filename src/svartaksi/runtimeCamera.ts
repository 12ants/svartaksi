/**
 * Thin, stateful bindings that apply an already-resolved camera shot to three.js.
 * Camera-mode decisions, intro timing, terrain clearance, and rig selection stay in
 * svartaksiRuntime; this module owns only reusable transform scratch objects and the
 * projection write at the edge of the frame loop.
 */
import * as THREE from 'three';

export type CameraTransformApplier = (
  camera: THREE.Camera,
  position: THREE.Vector3,
  lookAt: THREE.Vector3,
  blend: number,
) => void;

/** Creates one transform applier per mounted runtime, with no per-frame matrix or
 * quaternion allocation and no scratch state shared by separate runtime instances. */
export function createCameraTransformApplier(): CameraTransformApplier {
  const targetRotation = new THREE.Quaternion();
  const lookAtMatrix = new THREE.Matrix4();

  return (camera, position, lookAt, blend) => {
    targetRotation.setFromRotationMatrix(lookAtMatrix.lookAt(position, lookAt, camera.up));
    camera.position.lerp(position, blend);
    camera.quaternion.slerp(targetRotation, blend);
  };
}

/** Applies a perspective FOV only when it changes, avoiding a projection rebuild on
 * every frame and leaving orthographic or custom cameras alone. */
export function updateCameraFov(camera: THREE.Camera, fov: number): void {
  const perspective = camera as THREE.PerspectiveCamera;
  if (!perspective.isPerspectiveCamera || perspective.fov === fov) return;
  perspective.fov = fov;
  perspective.updateProjectionMatrix();
}
