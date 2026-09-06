import { browserFiles, type BrowserDirectoryHandle, type BrowserFiles } from '../files/browserFiles';
import { exportObject3D, type GeneratedModelFormat } from './exportObject3D';
import { generatedModelRegistry, type GeneratedModelEntry } from './generatedModelRegistry';

export interface GeneratedModelSaveResult {
  modelId: GeneratedModelEntry['id'];
  filename: string;
  delivery: 'written' | 'downloaded';
  outcome: 'success' | 'cancelled' | 'failed';
  error?: string;
}

interface SaveOptions {
  files?: BrowserFiles;
  directory?: BrowserDirectoryHandle;
}

function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function saveGeneratedModel(
  entry: GeneratedModelEntry,
  format: GeneratedModelFormat,
  options: SaveOptions = {},
): Promise<GeneratedModelSaveResult> {
  const files = options.files ?? browserFiles();
  const filename = `${entry.basename}.${format}`;
  const delivery = options.directory ? 'written' : 'downloaded';
  let model: ReturnType<GeneratedModelEntry['create']> | undefined;
  try {
    model = entry.create();
    const exported = await exportObject3D(model.root, format);
    if (options.directory) {
      const handle = await options.directory.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(exported.blob);
      await writable.close();
    } else {
      files.download(exported.blob, filename);
    }
    return { modelId: entry.id, filename, delivery, outcome: 'success' };
  } catch (error) {
    return {
      modelId: entry.id,
      filename,
      delivery,
      outcome: cancelled(error) ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    model?.dispose();
  }
}

export async function saveAllGeneratedModels(
  entries: readonly GeneratedModelEntry[] = generatedModelRegistry,
  files: BrowserFiles = browserFiles(),
): Promise<GeneratedModelSaveResult[]> {
  let directory: BrowserDirectoryHandle | undefined;
  if (files.pickDirectory) {
    try {
      directory = await files.pickDirectory();
    } catch (error) {
      if (cancelled(error)) {
        return entries.flatMap((entry) => (['gltf', 'glb'] as const).map((format) => ({
          modelId: entry.id,
          filename: `${entry.basename}.${format}`,
          delivery: 'written' as const,
          outcome: 'cancelled' as const,
        })));
      }
    }
  }

  const results: GeneratedModelSaveResult[] = [];
  for (const entry of entries) {
    for (const format of ['gltf', 'glb'] as const) {
      results.push(await saveGeneratedModel(entry, format, { files, directory }));
    }
  }
  return results;
}
