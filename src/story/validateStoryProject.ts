import { STORY_SCHEMA_VERSION, type StoryProject } from './types';

export interface StoryValidationError {
  path: string;
  message: string;
}

export interface StoryValidationResult {
  valid: boolean;
  errors: StoryValidationError[];
}

const triggerKinds = new Set(['manual', 'route-progress', 'near-place', 'interaction', 'phone-message']);
const effectKinds = new Set(['set-flag', 'dialogue']);
const exclusiveOutcomeFlags = new Set(['bonfire:kept-phone', 'bonfire:took-gps']);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateStoryProject(value: unknown): StoryValidationResult {
  const errors: StoryValidationError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });
  if (!object(value)) return { valid: false, errors: [{ path: '$', message: 'Expected an object' }] };
  if (value.schemaVersion !== STORY_SCHEMA_VERSION) add('schemaVersion', `Expected ${STORY_SCHEMA_VERSION}`);
  if (!nonBlank(value.id)) add('id', 'Must not be blank');
  if (!Array.isArray(value.flags)) add('flags', 'Expected an array');
  if (!Array.isArray(value.places)) add('places', 'Expected an array');
  if (!Array.isArray(value.beats)) add('beats', 'Expected an array');

  const flags = Array.isArray(value.flags) ? value.flags : [];
  const flagIds = new Set<string>();
  flags.forEach((flag, index) => {
    if (!nonBlank(flag)) add(`flags[${index}]`, 'Must not be blank');
    else if (flagIds.has(flag)) add(`flags[${index}]`, `Duplicate flag: ${flag}`);
    else flagIds.add(flag);
  });

  const places = Array.isArray(value.places) ? value.places : [];
  const placeIds = new Set<string>();
  places.forEach((place, index) => {
    if (!object(place) || !nonBlank(place.id) || !nonBlank(place.label)) {
      add(`places[${index}]`, 'Expected a place with non-blank id and label');
    } else if (placeIds.has(place.id)) add(`places[${index}].id`, `Duplicate id: ${place.id}`);
    else placeIds.add(place.id);
  });

  const beats = Array.isArray(value.beats) ? value.beats : [];
  const beatIds = new Set<string>();
  const dialogueIds = new Set<string>();
  beats.forEach((beat, beatIndex) => {
    const path = `beats[${beatIndex}]`;
    if (!object(beat)) { add(path, 'Expected an object'); return; }
    if (!nonBlank(beat.id)) add(`${path}.id`, 'Must not be blank');
    else if (beatIds.has(beat.id)) add(`${path}.id`, `Duplicate id: ${beat.id}`);
    else beatIds.add(beat.id);
    if (!nonBlank(beat.title)) add(`${path}.title`, 'Must not be blank');
    if (!Array.isArray(beat.requiredFlags)) add(`${path}.requiredFlags`, 'Expected an array');
    else beat.requiredFlags.forEach((flag, index) => {
      if (!nonBlank(flag) || !flagIds.has(flag)) add(`${path}.requiredFlags[${index}]`, `Unknown flag: ${String(flag)}`);
    });

    if (!object(beat.trigger) || !triggerKinds.has(String(beat.trigger.kind))) {
      add(`${path}.trigger`, 'Unknown trigger kind');
    } else if (beat.trigger.kind === 'route-progress') {
      if (!nonBlank(beat.trigger.routeId)) add(`${path}.trigger.routeId`, 'Must not be blank');
      if (typeof beat.trigger.progress !== 'number' || beat.trigger.progress < 0 || beat.trigger.progress > 1) {
        add(`${path}.trigger.progress`, 'Must be between 0 and 1');
      }
    } else if (beat.trigger.kind === 'near-place') {
      if (!nonBlank(beat.trigger.placeId) || !placeIds.has(beat.trigger.placeId)) add(`${path}.trigger.placeId`, 'Unknown authored place');
      if (typeof beat.trigger.radiusMeters !== 'number' || beat.trigger.radiusMeters <= 0) add(`${path}.trigger.radiusMeters`, 'Must be greater than 0');
    } else if (beat.trigger.kind === 'interaction' && !nonBlank(beat.trigger.targetId)) {
      add(`${path}.trigger.targetId`, 'Must not be blank');
    } else if (beat.trigger.kind === 'phone-message' && !nonBlank(beat.trigger.messageId)) {
      add(`${path}.trigger.messageId`, 'Must not be blank');
    }

    if (!Array.isArray(beat.effects)) { add(`${path}.effects`, 'Expected an array'); return; }
    const setOutcomes = new Set<string>();
    beat.effects.forEach((effect, effectIndex) => {
      const effectPath = `${path}.effects[${effectIndex}]`;
      if (!object(effect) || !effectKinds.has(String(effect.kind))) { add(effectPath, 'Unknown effect kind'); return; }
      if (effect.kind === 'set-flag') {
        if (!nonBlank(effect.flag) || !flagIds.has(effect.flag)) add(`${effectPath}.flag`, `Unknown flag: ${String(effect.flag)}`);
        if (typeof effect.flag === 'string' && exclusiveOutcomeFlags.has(effect.flag)) setOutcomes.add(effect.flag);
      } else if (effect.kind === 'dialogue') {
        if (!Array.isArray(effect.lines) || effect.lines.length === 0) add(`${effectPath}.lines`, 'Expected at least one line');
        else effect.lines.forEach((line, lineIndex) => {
          const linePath = `${effectPath}.lines[${lineIndex}]`;
          if (!object(line)) { add(linePath, 'Expected an object'); return; }
          if (!nonBlank(line.id)) add(`${linePath}.id`, 'Must not be blank');
          else if (dialogueIds.has(line.id)) add(`${linePath}.id`, `Duplicate id: ${line.id}`);
          else dialogueIds.add(line.id);
          if (!nonBlank(line.speakerId)) add(`${linePath}.speakerId`, 'Must not be blank');
          if (!nonBlank(line.text)) add(`${linePath}.text`, 'Must not be blank');
        });
      }
    });
    if (setOutcomes.size > 1) add(`${path}.effects`, 'Cannot set both phone and GPS outcome flags');
  });
  return { valid: errors.length === 0, errors };
}

export function isStoryProject(value: unknown): value is StoryProject {
  return validateStoryProject(value).valid;
}
