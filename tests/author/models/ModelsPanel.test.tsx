import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelsPanel } from '@/author/models/ModelsPanel';
import { saveGeneratedModel } from '@/author/models/saveGeneratedModels';

vi.mock('@/author/models/saveGeneratedModels', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/author/models/saveGeneratedModels')>();
  return {
    ...original,
    saveGeneratedModel: vi.fn(async (entry, format) => ({
      modelId: entry.id, filename: `${entry.basename}.${format}`,
      delivery: 'downloaded', outcome: 'success',
    })),
    saveAllGeneratedModels: vi.fn(async () => [{
      modelId: 'bus', filename: 'svartaksi-bus.glb', delivery: 'written', outcome: 'success',
    }]),
  };
});

describe('ModelsPanel', () => {
  it('lists every model and offers individual and bulk exports', () => {
    render(<ModelsPanel />);
    for (const label of ['Bus', 'Car', 'Player pill', 'Bonfire camp']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Export ${label} glTF` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Export ${label} GLB` })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Export all' })).toBeInTheDocument();
  });

  it('reports downloaded and written results in its status region', async () => {
    render(<ModelsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Export Bus GLB' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('svartaksi-bus.glb downloaded'));
    fireEvent.click(screen.getByRole('button', { name: 'Export all' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('svartaksi-bus.glb written'));
  });

  it('distinguishes cancelled and failed exports', async () => {
    const save = vi.mocked(saveGeneratedModel);
    save
      .mockResolvedValueOnce({
        modelId: 'bus', filename: 'svartaksi-bus.gltf', delivery: 'downloaded', outcome: 'cancelled',
      })
      .mockResolvedValueOnce({
        modelId: 'bus', filename: 'svartaksi-bus.glb', delivery: 'downloaded', outcome: 'failed', error: 'blocked',
      });
    render(<ModelsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Export Bus glTF' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('svartaksi-bus.gltf cancelled'));
    fireEvent.click(screen.getByRole('button', { name: 'Export Bus GLB' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('svartaksi-bus.glb failed: blocked'));
  });
});
