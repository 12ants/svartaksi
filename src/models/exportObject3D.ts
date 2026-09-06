import * as THREE from 'three';

export type GeneratedModelFormat = 'gltf' | 'glb';

export interface ExportedObject3D {
  blob: Blob;
  extension: GeneratedModelFormat;
  mimeType: 'model/gltf+json' | 'model/gltf-binary';
}

function sanitizedClone(root: THREE.Object3D): THREE.Object3D {
  const clone = root.clone(true);
  clone.traverse((object) => {
    for (const child of [...object.children]) {
      if (!(child instanceof THREE.Group) && !(child instanceof THREE.Mesh)) object.remove(child);
    }
    object.userData = Object.fromEntries(
      Object.entries(object.userData).filter(([, value]) => typeof value !== 'function'),
    );
    object.onBeforeRender = () => {};
    object.onAfterRender = () => {};
  });
  clone.updateMatrixWorld(true);
  return clone;
}

export async function exportObject3D(
  root: THREE.Object3D,
  format: GeneratedModelFormat,
): Promise<ExportedObject3D> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const result = await new GLTFExporter().parseAsync(sanitizedClone(root), {
    binary: format === 'glb',
  });

  if (format === 'glb') {
    return {
      blob: new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }),
      extension: format,
      mimeType: 'model/gltf-binary',
    };
  }
  return {
    blob: new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }),
    extension: format,
    mimeType: 'model/gltf+json',
  };
}
