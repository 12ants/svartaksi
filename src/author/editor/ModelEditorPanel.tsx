const editorSource = `${import.meta.env.BASE_URL}three-editor-r185/editor/index.html`;

export function ModelEditorPanel() {
  return (
    <section aria-labelledby="model-editor-heading" className="author-panel">
      <h2 id="model-editor-heading">3D Model Editor</h2>
      <p>Official Three.js r185 editor. Import exported glTF or GLB files through File → Import.</p>
      <iframe className="model-editor-frame" src={editorSource} title="Three.js r185 model editor" />
    </section>
  );
}
