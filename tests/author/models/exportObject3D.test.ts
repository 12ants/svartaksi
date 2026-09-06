import * as THREE from 'three';
import { exportObject3D } from '@/author/models/exportObject3D';

describe('exportObject3D', () => {
  function scene(): THREE.Group {
    const root = new THREE.Group();
    root.name = 'Authored root';
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.name = 'Named mesh';
    root.add(mesh, new THREE.PointLight(), new THREE.Object3D());
    root.children[2].userData.callback = () => undefined;
    return root;
  }

  it('exports named meshes as embedded glTF JSON', async () => {
    const exported = await exportObject3D(scene(), 'gltf');
    const document = JSON.parse(await exported.blob.text());

    expect(exported).toMatchObject({ extension: 'gltf', mimeType: 'model/gltf+json' });
    expect(document.asset.version).toBe('2.0');
    expect(document.buffers[0].uri).toMatch(/^data:/);
    expect(document.nodes.some((node: { name?: string }) => node.name === 'Named mesh')).toBe(true);
    expect(document.extensionsUsed).not.toContain('KHR_lights_punctual');
  });

  it('exports a named GLB with the binary magic header', async () => {
    const exported = await exportObject3D(scene(), 'glb');
    const bytes = new Uint32Array(await exported.blob.arrayBuffer());

    expect(exported).toMatchObject({ extension: 'glb', mimeType: 'model/gltf-binary' });
    expect(bytes[0]).toBe(0x46546c67);
  });
});
