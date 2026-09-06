import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoryEditor } from '@/author/story/StoryEditor';
import { openStoryProject, saveStoryProject } from '@/author/story/storyFileStore';

vi.mock('@/author/story/storyFileStore', () => ({
  openStoryProject: vi.fn(),
  saveStoryProject: vi.fn(),
}));

describe('StoryEditor', () => {
  it('supports master detail mutations and live validation', () => {
    render(<StoryEditor />);
    expect(screen.getByLabelText('Beat id')).toHaveValue('opening-ride');
    fireEvent.click(screen.getByRole('button', { name: 'Add beat' }));
    expect(screen.getByLabelText('Beat id')).toHaveValue('new-beat');
    fireEvent.change(screen.getByLabelText('Beat id'), { target: { value: '' } });
    expect(screen.getByLabelText('Validation errors')).toHaveTextContent('Must not be blank');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('exposes ordinary controls for all trigger kinds and effect kinds', () => {
    render(<StoryEditor />);
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'interaction' } });
    expect(screen.getByLabelText('Target id')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add dialogue effect' }));
    expect(screen.getByRole('group', { name: 'Dialogue' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add dialogue line' }));
    expect(screen.getByLabelText('Speaker id')).toBeInTheDocument();
  });

  it('preserves the current project after an invalid open and reports download saves', async () => {
    vi.mocked(openStoryProject).mockResolvedValue({ outcome: 'failed', errors: [{ path: '$', message: 'invalid story' }] });
    vi.mocked(saveStoryProject).mockResolvedValue({
      outcome: 'success', delivery: 'downloaded',
      document: { project: { schemaVersion: 1, id: 'svartaksi-opening', flags: [], places: [], beats: [] } },
    });
    render(<StoryEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Open failed: invalid story'));
    expect(screen.getByLabelText('Beat id')).toHaveValue('opening-ride');
    fireEvent.click(screen.getByRole('button', { name: 'Save As' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Story downloaded'));
  });
});
