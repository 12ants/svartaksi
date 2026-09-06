import project from '@/story/projects/svartaksi-opening.json';
import { parseStoryProject } from '@/story/parseStoryProject';

describe('svartaksi opening story project', () => {
  it('validates and survives a JSON round trip', () => {
    const parsed = parseStoryProject(JSON.stringify(project));
    expect(parsed).toEqual({ ok: true, project });
  });
});
