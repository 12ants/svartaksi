import type { BrowserFileHandle, BrowserFiles } from '@/author/files/browserFiles';
import { openStoryProject, saveStoryProject } from '@/author/story/storyFileStore';
import type { StoryProject } from '@/story/types';

const project: StoryProject = { schemaVersion: 1, id: 'story', flags: [], places: [], beats: [] };
function handle(text = JSON.stringify(project)): BrowserFileHandle {
  return { getFile: async () => ({ text: async () => text }), createWritable: async () => ({ write: vi.fn(), close: vi.fn() }) };
}

describe('storyFileStore', () => {
  it('opens valid files and rejects invalid files without producing a document', async () => {
    expect(await openStoryProject({ pickOpenFile: async () => handle(), download: vi.fn() })).toMatchObject({ outcome: 'success', document: { project } });
    expect(await openStoryProject({ pickOpenFile: async () => handle('{}'), download: vi.fn() })).toMatchObject({ outcome: 'failed' });
  });

  it('saves through retained handles and Save As handles', async () => {
    const retained = handle(); const saveAs = handle();
    expect(await saveStoryProject({ project, handle: retained }, { files: { download: vi.fn() } })).toMatchObject({ delivery: 'written' });
    const files: BrowserFiles = { pickSaveFile: async () => saveAs, download: vi.fn() };
    expect(await saveStoryProject({ project, handle: retained }, { saveAs: true, files })).toMatchObject({ delivery: 'written', document: { handle: saveAs } });
  });

  it('downloads when save handles are unsupported and reports cancellation', async () => {
    const download = vi.fn();
    expect(await saveStoryProject({ project }, { files: { download } })).toMatchObject({ delivery: 'downloaded' });
    expect(download).toHaveBeenCalledOnce();
    const files: BrowserFiles = { pickSaveFile: async () => { throw new DOMException('', 'AbortError'); }, download };
    expect(await saveStoryProject({ project }, { saveAs: true, files })).toEqual({ outcome: 'cancelled' });
  });
});
