import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { START_LOCATION } from '@/svartaksi/config';
import { createThreeWorld } from '@/world/threeWorld';
import { createMapLibreProvider } from '@/world/providers/maplibreProvider';
import { browserFiles } from '../files/browserFiles';
import { createDefaultProceduralProject } from '@/world/procedural/defaultProject';
import { PROCEDURAL_PRESETS } from '@/world/procedural/presets';
import { resolveProceduralWorld } from '@/world/procedural/resolveProceduralWorld';
import { PROCEDURAL_SAMPLE_WORLD } from '@/world/procedural/sampleWorld';
import type { ProceduralCategory, ProceduralRule, ProceduralWorldProject } from '@/world/procedural/types';
import type { WorldData } from '@/world/types';

const categories: ProceduralCategory[] = ['buildings', 'roads', 'parks', 'water', 'trees', 'objects'];

function downloadJson(value: unknown, filename: string) {
  browserFiles().download(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), filename);
}

function isProject(value: unknown): value is ProceduralWorldProject {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<ProceduralWorldProject>;
  return project.version === 1 && typeof project.id === 'string' && typeof project.seed === 'number'
    && Array.isArray(project.rules) && Array.isArray(project.areas) && Boolean(project.renderOptions)
    && Boolean(project.source) && Boolean(project.overlay);
}

function WorldPreview({ data, project }: { data: WorldData; project: ProceduralWorldProject }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deferredProject = useDeferredValue(project);
  const resolved = useMemo(() => resolveProceduralWorld(data, deferredProject), [data, deferredProject]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let frame = 0;
    let disposed = false;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      renderer.shadowMap.enabled = deferredProject.renderOptions.highQualityShadows;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111111);
      scene.fog = new THREE.FogExp2(0x111111, 0.0018);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4);
      sun.position.set(80, 120, 60);
      scene.add(sun);
      const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4_000);
      camera.position.set(145, 115, 145);
      const controls = new OrbitControls(camera, canvas);
      controls.target.set(0, 8, 0);
      controls.update();
      const world = createThreeWorld(scene);
      world.setRenderOptions(deferredProject.renderOptions);
      world.replace(resolved, { incremental: true });
      const resize = () => {
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        renderer?.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();
      const render = (time: number) => {
        if (disposed) return;
        world.pump(6);
        world.setAnimationTime(time / 1_000);
        controls.update();
        renderer?.render(scene, camera);
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        world.dispose();
        renderer?.dispose();
      };
    } catch {
      renderer?.dispose();
    }
  }, [deferredProject.renderOptions, resolved]);

  return <canvas aria-label="Procedural world preview" className="world-editor-preview" ref={canvasRef} />;
}

function newRule(index: number): ProceduralRule {
  return {
    id: `rule-${index}`,
    name: `Rule ${index}`,
    enabled: true,
    match: { category: 'buildings' },
    effects: { visible: true, probability: 1, variation: 0 },
  };
}

export function WorldEditor() {
  const [project, setProject] = useState(createDefaultProceduralProject);
  const [source, setSource] = useState<WorldData>(PROCEDURAL_SAMPLE_WORLD);
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState('Sample world ready');
  const [loading, setLoading] = useState(false);
  const loadController = useRef<AbortController | null>(null);
  const selected = project.rules.find(({ id }) => id === selectedId);

  const updateRule = (change: (rule: ProceduralRule) => ProceduralRule) => {
    setProject((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === selectedId ? change(rule) : rule),
    }));
  };

  async function loadLive() {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setStatus('Loading live world');
    try {
      const center = project.source.center ?? START_LOCATION;
      const radius = project.source.radius ?? 650;
      const data = await createMapLibreProvider().load(
        center,
        { buildings: radius, terrain: radius },
        controller.signal,
        center,
      );
      setSource(data);
      setProject((current) => ({ ...current, source: { kind: 'live', center, radius } }));
      setStatus(`Live world ready: ${data.buildings.length} buildings`);
    } catch (error) {
      setStatus(`Live load failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (loadController.current === controller) setLoading(false);
    }
  }

  async function openProject() {
    try {
      const handle = await browserFiles().pickOpenFile?.();
      const file = await handle?.getFile?.();
      const candidate: unknown = JSON.parse(await file!.text());
      if (!isProject(candidate)) throw new Error('Not a Svartaksi procedural world project');
      setProject(candidate);
      setSelectedId(candidate.rules[0]?.id);
      setStatus(`${candidate.name} opened`);
      if (candidate.source.kind === 'sample') setSource(PROCEDURAL_SAMPLE_WORLD);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const useSample = () => {
    loadController.current?.abort();
    setSource(PROCEDURAL_SAMPLE_WORLD);
    setProject((current) => ({ ...current, source: { kind: 'sample' } }));
    setStatus('Sample world ready');
  };

  useEffect(() => () => loadController.current?.abort(), []);

  return (
    <section aria-labelledby="world-editor-heading" className="author-panel world-editor">
      <header className="world-editor-toolbar">
        <div><p className="author-kicker">Procedural generation</p><h2 id="world-editor-heading">World Editor</h2></div>
        <div className="author-actions">
          <button aria-pressed={project.source.kind === 'sample'} onClick={useSample} type="button">Sample</button>
          <button aria-pressed={project.source.kind === 'live'} disabled={loading} onClick={() => void loadLive()} type="button">Live world</button>
          <button onClick={() => void openProject()} type="button">Open project</button>
          <button onClick={() => downloadJson(project, `${project.id}.world.json`)} type="button">Save project</button>
          <button onClick={() => downloadJson({ version: 1, id: `${project.id}-preset`, name: `${project.name} preset`, rules: project.rules, renderOptions: project.renderOptions }, `${project.id}.preset.json`)} type="button">Save preset</button>
          <button onClick={() => downloadJson(resolveProceduralWorld(source, project), `${project.id}.snapshot.json`)} type="button">Export snapshot</button>
        </div>
      </header>
      <div className="world-editor-layout">
        <aside className="world-editor-sidebar" aria-label="Presets and rules">
          <h3>Presets</h3>
          <div className="preset-list">
            {PROCEDURAL_PRESETS.map((preset) => <button key={preset.id} onClick={() => {
              setProject((current) => ({ ...current, rules: preset.rules.map((rule) => ({ ...rule })), renderOptions: { ...current.renderOptions, ...preset.renderOptions } }));
              setSelectedId(preset.rules[0]?.id);
              setStatus(`${preset.name} applied`);
            }} type="button">{preset.name}</button>)}
          </div>
          <div className="section-heading"><h3>Rules</h3><button onClick={() => {
            const rule = newRule(project.rules.length + 1);
            setProject((current) => ({ ...current, rules: [...current.rules, rule] }));
            setSelectedId(rule.id);
          }} type="button">Add rule</button></div>
          <ol className="rule-list">
            {project.rules.map((rule) => <li key={rule.id}><button aria-pressed={rule.id === selectedId} onClick={() => setSelectedId(rule.id)} type="button">{rule.name}</button></li>)}
          </ol>
        </aside>
        <div className="world-editor-stage"><WorldPreview data={source} project={project} /></div>
        <aside className="world-editor-inspector" aria-label="Rule settings">
          <h3>Rule settings</h3>
          {!selected && <p>Select or add a rule.</p>}
          {selected && <div className="field-stack">
            <label>Name<input value={selected.name} onChange={(event) => updateRule((rule) => ({ ...rule, name: event.target.value }))} /></label>
            <label>Layer<select value={selected.match.category} onChange={(event) => updateRule((rule) => ({ ...rule, match: { ...rule.match, category: event.target.value as ProceduralCategory } }))}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
            <label className="check-row"><input checked={selected.effects.visible !== false} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, visible: event.target.checked } }))} type="checkbox" /> Render layer</label>
            <label>Probability <output>{selected.effects.probability ?? 1}</output><input min="0" max="1" step="0.05" type="range" value={selected.effects.probability ?? 1} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, probability: Number(event.target.value) } }))} /></label>
            <label>Variation <output>{selected.effects.variation ?? 0}</output><input min="0" max="0.5" step="0.01" type="range" value={selected.effects.variation ?? 0} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, variation: Number(event.target.value) } }))} /></label>
            <label>Height scale<input min="0.2" max="3" step="0.1" type="number" value={selected.effects.heightScale ?? 1} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, heightScale: Number(event.target.value) } }))} /></label>
            <label>Road width<input min="0.2" max="3" step="0.1" type="number" value={selected.effects.widthScale ?? 1} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, widthScale: Number(event.target.value) } }))} /></label>
            <label>Density<input min="0" max="2" step="0.05" type="number" value={selected.effects.density ?? 1} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, density: Number(event.target.value) } }))} /></label>
            <label>Wall color<input type="color" value={selected.effects.wallColor ?? '#888888'} onChange={(event) => updateRule((rule) => ({ ...rule, effects: { ...rule.effects, wallColor: event.target.value } }))} /></label>
            <button className="danger-action" onClick={() => { setProject((current) => ({ ...current, rules: current.rules.filter(({ id }) => id !== selected.id) })); setSelectedId(undefined); }} type="button">Remove rule</button>
          </div>}
        </aside>
      </div>
      <footer aria-live="polite" className="world-editor-status" role="status"><span>{status}</span><span>Seed {project.seed}</span><span>{source.buildings.length} buildings</span><span>{source.objects.length} objects</span></footer>
    </section>
  );
}
