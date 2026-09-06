import * as THREE from 'three';
import type { BrowserFiles } from '@/author/files/browserFiles';
import type { GeneratedModelEntry } from '@/author/models/generatedModelRegistry';
import { saveAllGeneratedModels, saveGeneratedModel } from '@/author/models/saveGeneratedModels';

function entry(id: GeneratedModelEntry['id'] = 'car'): GeneratedModelEntry {
  return {
    id, label: id, basename: `stable-${id}`,
    create: () => ({ root: new THREE.Group(), dispose: vi.fn() }),
  };
}

describe('saveGeneratedModels', () => {
  it('writes a selected-directory file with a stable name', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const getFileHandle = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    const model = entry();
    const created = model.create();
    model.create = () => created;
    const result = await saveGeneratedModel(model, 'glb', {
      files: { download: vi.fn() }, directory: { getFileHandle },
    });
    expect(result).toMatchObject({ filename: 'stable-car.glb', delivery: 'written', outcome: 'success' });
    expect(getFileHandle).toHaveBeenCalledWith('stable-car.glb', { create: true });
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(created.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the temporary model when delivery fails', async () => {
    const model = entry();
    const created = model.create();
    model.create = () => created;
    const directory = {
      getFileHandle: vi.fn(async () => ({
        createWritable: async () => ({
          write: async () => { throw new Error('disk full'); },
          close: vi.fn(),
        }),
      })),
    };

    const result = await saveGeneratedModel(model, 'gltf', {
      files: { download: vi.fn() }, directory,
    });

    expect(result).toMatchObject({ outcome: 'failed', error: 'disk full' });
    expect(created.dispose).toHaveBeenCalledOnce();
  });

  it('falls back to downloads and continues after a failed entry', async () => {
    const download = vi.fn();
    const broken = entry('bus');
    broken.create = () => { throw new Error('broken model'); };
    const files: BrowserFiles = { download };
    const results = await saveAllGeneratedModels([broken, entry()], files);
    expect(results.map(({ outcome }) => outcome)).toEqual(['failed', 'failed', 'success', 'success']);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('reports directory-picker cancellation without constructing models', async () => {
    const model = entry();
    model.create = vi.fn(model.create);
    const files: BrowserFiles = {
      pickDirectory: vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); }),
      download: vi.fn(),
    };
    const results = await saveAllGeneratedModels([model], files);
    expect(results).toHaveLength(2);
    expect(results.every(({ outcome }) => outcome === 'cancelled')).toBe(true);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('revokes object URLs in the browser download adapter', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { browserFiles } = await import('@/author/files/browserFiles');
    browserFiles().download(new Blob(), 'model.glb');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });
});
