import type { StoryProject } from './types';
import { validateStoryProject, type StoryValidationError } from './validateStoryProject';

export type ParseStoryProjectResult =
  | { ok: true; project: StoryProject }
  | { ok: false; errors: StoryValidationError[] };

export function parseStoryProject(input: unknown): ParseStoryProjectResult {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input) as unknown; }
    catch (error) {
      return { ok: false, errors: [{ path: '$', message: error instanceof Error ? error.message : 'Invalid JSON' }] };
    }
  }
  const validation = validateStoryProject(value);
  return validation.valid
    ? { ok: true, project: value as StoryProject }
    : { ok: false, errors: validation.errors };
}
