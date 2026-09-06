import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { generatedModelRegistry, type GeneratedModelEntry } from './generatedModelRegistry';
import {
  saveAllGeneratedModels,
  saveGeneratedModel,
  type GeneratedModelSaveResult,
} from './saveGeneratedModels';

function ModelPreview({ entry }: { entry: GeneratedModelEntry }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const instance = entry.create();
    const canvas = canvasRef.current;
    let frame = 0;
    let renderer: THREE.WebGLRenderer | undefined;
    if (canvas) {
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(420, 280, false);
        const scene = new THREE.Scene();
        scene.add(instance.root);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x253044, 2.4));
        const camera = new THREE.PerspectiveCamera(38, 1.5, 0.01, 2_000);
        const bounds = new THREE.Box3().setFromObject(instance.root);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        camera.position.set(sphere.radius * 1.8, sphere.radius * 1.2, sphere.radius * 2.4);
        camera.lookAt(sphere.center);
        const render = () => {
          instance.root.rotation.y += 0.004;
          renderer?.render(scene, camera);
          frame = requestAnimationFrame(render);
        };
        render();
      } catch {
        // Unit-test DOMs and machines without WebGL still retain the export controls.
      }
    }
    return () => {
      cancelAnimationFrame(frame);
      renderer?.dispose();
      instance.dispose();
    };
  }, [entry]);

  return <canvas aria-label={`${entry.label} preview`} className="model-preview" ref={canvasRef} />;
}

function resultMessage(result: GeneratedModelSaveResult): string {
  if (result.outcome === 'success') return `${result.filename} ${result.delivery}`;
  if (result.outcome === 'cancelled') return `${result.filename} cancelled`;
  return `${result.filename} failed${result.error ? `: ${result.error}` : ''}`;
}

export function ModelsPanel() {
  const [selected, setSelected] = useState(generatedModelRegistry[0]);
  const [results, setResults] = useState<GeneratedModelSaveResult[]>([]);
  const [busy, setBusy] = useState(false);

  async function save(entry: GeneratedModelEntry, format: 'gltf' | 'glb') {
    setBusy(true);
    try {
      setResults([await saveGeneratedModel(entry, format)]);
    } finally {
      setBusy(false);
    }
  }

  async function saveAll() {
    setBusy(true);
    try {
      setResults(await saveAllGeneratedModels());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="models-heading" className="author-panel models-panel">
      <div>
        <h2 id="models-heading">Models</h2>
        <p>Export fresh procedural models as self-contained glTF or GLB files.</p>
        <ul className="model-list">
          {generatedModelRegistry.map((entry) => (
            <li key={entry.id}>
              <button
                aria-pressed={selected.id === entry.id}
                onClick={() => setSelected(entry)}
                type="button"
              >
                {entry.label}
              </button>
              <button disabled={busy} onClick={() => void save(entry, 'gltf')} type="button">
                Export {entry.label} glTF
              </button>
              <button disabled={busy} onClick={() => void save(entry, 'glb')} type="button">
                Export {entry.label} GLB
              </button>
            </li>
          ))}
        </ul>
        <button className="primary-action" disabled={busy} onClick={() => void saveAll()} type="button">
          Export all
        </button>
      </div>
      <div>
        <ModelPreview entry={selected} />
        <div aria-live="polite" className="export-status" role="status">
          {busy ? 'Exporting…' : results.map(resultMessage).join('. ')}
        </div>
      </div>
    </section>
  );
}
