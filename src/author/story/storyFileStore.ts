import { browserFiles, type BrowserFileHandle, type BrowserFiles } from '../files/browserFiles';
import { parseStoryProject } from '@/story/parseStoryProject';
import type { StoryProject } from '@/story/types';
import { validateStoryProject, type StoryValidationError } from '@/story/validateStoryProject';

export interface StoryDocument {
  project: StoryProject;
  handle?: BrowserFileHandle;
}

export type StoryFileResult =
  | { outcome: 'success'; delivery: 'opened' | 'written' | 'downloaded'; document: StoryDocument }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; errors: StoryValidationError[] };

function cancelled(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function failure(error: unknown): StoryFileResult {
  return { outcome: 'failed', errors: [{ path: '$', message: error instanceof Error ? error.message : String(error) }] };
}

export async function openStoryProject(files: BrowserFiles = browserFiles()): Promise<StoryFileResult> {
  if (!files.pickOpenFile) return failure(new Error('Opening files is not supported by this browser'));
  try {
    const handle = await files.pickOpenFile();
    if (!handle.getFile) return failure(new Error('The selected file cannot be read'));
    const parsed = parseStoryProject(await (await handle.getFile()).text());
    return parsed.ok
      ? { outcome: 'success', delivery: 'opened', document: { project: parsed.project, handle } }
      : { outcome: 'failed', errors: parsed.errors };
  } catch (error) {
    return cancelled(error) ? { outcome: 'cancelled' } : failure(error);
  }
}

async function write(handle: BrowserFileHandle, project: StoryProject) {
  const writable = await handle.createWritable();
  await writable.write(new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: 'application/json' }));
  await writable.close();
}

export async function saveStoryProject(
  document: StoryDocument,
  options: { saveAs?: boolean; files?: BrowserFiles } = {},
): Promise<StoryFileResult> {
  const validation = validateStoryProject(document.project);
  if (!validation.valid) return { outcome: 'failed', errors: validation.errors };
  const files = options.files ?? browserFiles();
  try {
    let handle = options.saveAs ? undefined : document.handle;
    if (!handle && files.pickSaveFile) handle = await files.pickSaveFile(`${document.project.id}.json`);
    if (handle) {
      await write(handle, document.project);
      return { outcome: 'success', delivery: 'written', document: { ...document, handle } };
    }
    files.download(new Blob([`${JSON.stringify(document.project, null, 2)}\n`], { type: 'application/json' }), `${document.project.id}.json`);
    return { outcome: 'success', delivery: 'downloaded', document };
  } catch (error) {
    return cancelled(error) ? { outcome: 'cancelled' } : failure(error);
  }
}
