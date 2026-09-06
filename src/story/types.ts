export const STORY_SCHEMA_VERSION = 1 as const;

export interface StoryDialogueLine {
  id: string;
  speakerId: string;
  text: string;
}

export type StoryTrigger =
  | { kind: 'manual' }
  | { kind: 'route-progress'; routeId: string; progress: number }
  | { kind: 'near-place'; placeId: string; radiusMeters: number }
  | { kind: 'interaction'; targetId: string }
  /** Fires once the player has received a specific phone message, matched by that
   * message's stable id rather than its (localized, mutable) body text. */
  | { kind: 'phone-message'; messageId: string };

export type StoryEffect =
  | { kind: 'set-flag'; flag: string }
  | { kind: 'dialogue'; lines: StoryDialogueLine[] };

export interface StoryBeat {
  id: string;
  title: string;
  description?: string;
  trigger: StoryTrigger;
  requiredFlags: string[];
  effects: StoryEffect[];
}

export interface AuthoredStoryPlace {
  id: string;
  label: string;
}

export interface StoryProject {
  schemaVersion: typeof STORY_SCHEMA_VERSION;
  id: string;
  flags: string[];
  places: AuthoredStoryPlace[];
  beats: StoryBeat[];
}
