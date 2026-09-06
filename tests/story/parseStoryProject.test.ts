import { parseStoryProject } from '@/story/parseStoryProject';

describe('parseStoryProject', () => {
  it('accepts valid unknown JSON without exposing invalid input', () => {
    const source = { schemaVersion: 1, id: 'empty', flags: [], places: [], beats: [] };
    expect(parseStoryProject(JSON.stringify(source))).toEqual({ ok: true, project: source });
    expect(parseStoryProject('{')).toMatchObject({ ok: false });
    expect(parseStoryProject({ ...source, schemaVersion: 4 })).toMatchObject({ ok: false });
  });
});
