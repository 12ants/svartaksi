import { validateStoryProject } from '@/story/validateStoryProject';

function project() {
  return {
    schemaVersion: 1, id: 'test', flags: ['known', 'bonfire:kept-phone', 'bonfire:took-gps'],
    places: [{ id: 'camp', label: 'Camp' }],
    beats: [{ id: 'beat', title: 'Beat', trigger: { kind: 'manual' }, requiredFlags: ['known'], effects: [
      { kind: 'dialogue', lines: [{ id: 'line', speakerId: 'pill', text: 'Hello' }] },
    ] }],
  };
}

describe('validateStoryProject', () => {
  it.each([
    ['wrong version', (value: ReturnType<typeof project>) => { value.schemaVersion = 2; }, 'schemaVersion'],
    ['duplicate ids', (value: ReturnType<typeof project>) => { value.beats.push({ ...value.beats[0] }); }, 'beats[1].id'],
    ['unknown required flag', (value: ReturnType<typeof project>) => { value.beats[0].requiredFlags = ['missing']; }, 'requiredFlags'],
    ['route progress outside the unit range', (value: ReturnType<typeof project>) => { value.beats[0].trigger = { kind: 'route-progress', routeId: 'ride', progress: 2 } as never; }, 'progress'],
    ['unknown authored place', (value: ReturnType<typeof project>) => { value.beats[0].trigger = { kind: 'near-place', placeId: 'missing', radiusMeters: 6 } as never; }, 'placeId'],
    ['blank dialogue', (value: ReturnType<typeof project>) => { value.beats[0].effects[0] = { kind: 'dialogue', lines: [{ id: 'line', speakerId: 'pill', text: ' ' }] }; }, 'text'],
  ])('rejects %s', (_name, mutate, expectedPath) => {
    const value = project(); mutate(value);
    expect(validateStoryProject(value).errors.some(({ path }) => path.includes(expectedPath))).toBe(true);
  });

  it('rejects mutually exclusive phone and GPS outcomes in one effect set', () => {
    const value = project();
    value.beats[0].effects = [
      { kind: 'set-flag', flag: 'bonfire:kept-phone', lines: undefined } as never,
      { kind: 'set-flag', flag: 'bonfire:took-gps', lines: undefined } as never,
    ];
    expect(validateStoryProject(value).errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('both phone and GPS') }));
  });
});
