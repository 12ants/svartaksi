import { render, screen } from '@testing-library/react';
import { ModelEditorPanel } from '@/author/editor/ModelEditorPanel';

describe('ModelEditorPanel', () => {
  it('embeds the isolated r185 editor application', () => {
    render(<ModelEditorPanel />);
    expect(screen.getByTitle('Three.js r185 model editor')).toHaveAttribute('src', '/three-editor-r185/editor/index.html');
  });
});
