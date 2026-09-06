import { lazy, Suspense, useState } from 'react';
import { ModelsPanel } from './models/ModelsPanel';
import { StoryEditor } from './story/StoryEditor';
import { ModelEditorPanel } from './editor/ModelEditorPanel';

const WorldEditor = lazy(async () => {
  const module = await import('./world/WorldEditor');
  return { default: module.WorldEditor };
});

const tabs = ['Models', '3D Model Editor', 'Story Editor', 'World Editor'] as const;
type AuthorTab = (typeof tabs)[number];

export function AuthorApp() {
  const [activeTab, setActiveTab] = useState<AuthorTab>('Models');

  return (
    <main className="author-app">
      <header className="author-header">
        <div>
          <p className="author-kicker">Svartaksi tools</p>
          <h1>Author Studio</h1>
        </div>
        <a className="back-to-game" href="/">&larr; Back to game</a>
      </header>
      <nav aria-label="Author sections" className="author-tabs">
        {tabs.map((tab) => (
          <button
            aria-current={activeTab === tab ? 'page' : undefined}
            key={tab}
            onClick={() => setActiveTab(tab)}
            type="button"
          >
            {tab}
          </button>
        ))}
      </nav>
      {activeTab === 'Models' && <ModelsPanel />}
      {activeTab === '3D Model Editor' && <ModelEditorPanel />}
      {activeTab === 'Story Editor' && <StoryEditor />}
      {activeTab === 'World Editor' && <Suspense fallback={<p role="status">Loading world editor</p>}><WorldEditor /></Suspense>}
    </main>
  );
}
