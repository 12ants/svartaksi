import { describe, expect, it } from 'vitest';

import {
  AD_MESSAGES,
  FOREST_RAVE_MESSAGE_ID,
  INBOX_CAPACITY,
  MONKEY_CAGE_REVEAL_ID,
  MYSTERIOUS_SENDER,
  MYSTERIOUS_VERSE_COUNT,
  PHONE_PRESETS,
  SENT_FROM,
  addToInbox,
  advanceForestRaveSchedule,
  advanceMysteriousSchedule,
  advanceSmsSchedule,
  createForestRaveSchedule,
  createMysteriousSchedule,
  createRandom,
  createSmsSchedule,
  markRead,
  phoneClock,
  sendPreset,
  signalBars,
  unreadCount,
  type PhoneMessage,
} from '../../src/svartaksi/phone';
import { LOADING_VERSES } from '../../src/svartaksi/loadingPoetry';

const message = (id: string, read = false): PhoneMessage => ({
  id, from: 'TEST', body: 'body', at: 0, read,
});

describe('ad sms schedule', () => {
  it('holds the first ad back until the ride is actually under way', () => {
    const schedule = createSmsSchedule(createRandom(1), 0);
    expect(schedule.dueAt).toBeGreaterThan(40);
    expect(schedule.dueAt).toBeLessThan(110);
    expect(advanceSmsSchedule(schedule, schedule.dueAt - 0.1, createRandom(1)).message).toBeNull();
  });

  it('sends one ad when it is due and books the next one further out', () => {
    const random = createRandom(7);
    const first = createSmsSchedule(random, 0);
    const { message: sent, schedule: next } = advanceSmsSchedule(first, first.dueAt, random);

    expect(sent).not.toBeNull();
    expect(AD_MESSAGES.some((ad) => ad.body === sent!.body)).toBe(true);
    expect(sent!.read).toBe(false);
    expect(next.sent).toBe(1);
    expect(next.dueAt).toBeGreaterThan(first.dueAt + 90);
  });

  it('never repeats an ad back to back', () => {
    const random = createRandom(3);
    let schedule = createSmsSchedule(random, 0);
    let previous: string | null = null;
    for (let round = 0; round < 30; round += 1) {
      const result = advanceSmsSchedule(schedule, schedule.dueAt, random);
      schedule = result.schedule;
      expect(result.message!.body).not.toBe(previous);
      previous = result.message!.body;
    }
  });

  it('gives every message its own id, so an inbox can key on it', () => {
    const random = createRandom(11);
    let schedule = createSmsSchedule(random, 0);
    const ids = new Set<string>();
    for (let round = 0; round < 25; round += 1) {
      const result = advanceSmsSchedule(schedule, schedule.dueAt, random);
      schedule = result.schedule;
      ids.add(result.message!.id);
    }
    expect(ids.size).toBe(25);
  });

  it('sends one ad, not a backlog, when the clock jumps', () => {
    // A backgrounded tab comes back with minutes of missed gaps. Emptying the whole ad
    // bank onto the screen at once is the one behaviour worth ruling out.
    const random = createRandom(5);
    const schedule = createSmsSchedule(random, 0);
    const { message: sent, schedule: next } = advanceSmsSchedule(schedule, 10_000, random);
    expect(sent).not.toBeNull();
    // ...and the next one is booked from now rather than from when it was due, so the
    // queue drains instead of firing again on the very next tick.
    expect(next.dueAt).toBeGreaterThan(10_000);
  });

  it('runs the same ads from the same seed', () => {
    const run = (seed: number) => {
      const random = createRandom(seed);
      let schedule = createSmsSchedule(random, 0);
      return Array.from({ length: 6 }, () => {
        const result = advanceSmsSchedule(schedule, schedule.dueAt, random);
        schedule = result.schedule;
        return result.message!.body;
      });
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });
});

describe('mysterious-number schedule (infinite_monkey_cage hook)', () => {
  it('holds the first verse back well past when the ad ticker would have fired', () => {
    const schedule = createMysteriousSchedule(createRandom(1), LOADING_VERSES.length, 0);
    expect(schedule.dueAt).toBeGreaterThan(230);
    expect(advanceMysteriousSchedule(schedule, schedule.dueAt - 0.1, createRandom(1), LOADING_VERSES).message).toBeNull();
  });

  it('sends verses one at a time, each an actual loading-screen poem, from the unlisted sender', () => {
    const random = createRandom(9);
    let schedule = createMysteriousSchedule(random, LOADING_VERSES.length, 0);
    const knownBodies = new Set(LOADING_VERSES.map((verse) => verse.lines.join(' ')));
    for (let round = 0; round < MYSTERIOUS_VERSE_COUNT; round += 1) {
      const result = advanceMysteriousSchedule(schedule, schedule.dueAt, random, LOADING_VERSES);
      schedule = result.schedule;
      expect(result.message!.from).toBe(MYSTERIOUS_SENDER);
      expect(knownBodies.has(result.message!.body)).toBe(true);
      expect(schedule.done).toBe(false);
    }
  });

  it('follows the last verse with exactly one reveal naming the quest, then goes silent', () => {
    const random = createRandom(9);
    let schedule = createMysteriousSchedule(random, LOADING_VERSES.length, 0);
    for (let round = 0; round < MYSTERIOUS_VERSE_COUNT; round += 1) {
      schedule = advanceMysteriousSchedule(schedule, schedule.dueAt, random, LOADING_VERSES).schedule;
    }
    const reveal = advanceMysteriousSchedule(schedule, schedule.dueAt, random, LOADING_VERSES);
    expect(reveal.message!.id).toBe(MONKEY_CAGE_REVEAL_ID);
    expect(reveal.message!.body).toContain('infinite_monkey_cage');
    expect(reveal.schedule.done).toBe(true);

    const after = advanceMysteriousSchedule(reveal.schedule, reveal.schedule.dueAt + 10_000, random, LOADING_VERSES);
    expect(after.message).toBeNull();
  });

  it('never repeats a verse within one run', () => {
    const schedule = createMysteriousSchedule(createRandom(4), LOADING_VERSES.length, 0);
    expect(new Set(schedule.order).size).toBe(schedule.order.length);
  });

  it('runs the same verse sequence from the same seed', () => {
    const run = (seed: number) => {
      const random = createRandom(seed);
      let schedule = createMysteriousSchedule(random, LOADING_VERSES.length, 0);
      const bodies: string[] = [];
      for (let round = 0; round < MYSTERIOUS_VERSE_COUNT; round += 1) {
        const result = advanceMysteriousSchedule(schedule, schedule.dueAt, random, LOADING_VERSES);
        schedule = result.schedule;
        bodies.push(result.message!.body);
      }
      return bodies;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });
});

describe('inbox', () => {
  it('puts the newest message first and drops the oldest past capacity', () => {
    let inbox: PhoneMessage[] = [];
    for (let index = 0; index < INBOX_CAPACITY + 5; index += 1) {
      inbox = addToInbox(inbox, message(`m${index}`));
    }
    expect(inbox).toHaveLength(INBOX_CAPACITY);
    expect(inbox[0].id).toBe(`m${INBOX_CAPACITY + 4}`);
    expect(inbox.some((entry) => entry.id === 'm0')).toBe(false);
  });

  it('counts and clears unread without touching the rest', () => {
    const inbox = [message('a'), message('b'), message('c', true)];
    expect(unreadCount(inbox)).toBe(2);

    const after = markRead(inbox, 'b');
    expect(unreadCount(after)).toBe(1);
    expect(after.find((entry) => entry.id === 'b')!.read).toBe(true);
    expect(after.find((entry) => entry.id === 'a')!.read).toBe(false);
    // Marking something that is not there is a no-op, not a crash.
    expect(markRead(inbox, 'nope')).toEqual(inbox);
  });
});

describe('phone screen', () => {
  it('shows the world clock, not the machine clock', () => {
    expect(phoneClock(0)).toBe('00:00');
    expect(phoneClock(13.5)).toBe('13:30');
    expect(phoneClock(23.99)).toBe('23:59');
    // The time of day wraps, and so must the phone.
    expect(phoneClock(24.25)).toBe('00:15');
    expect(phoneClock(-1)).toBe('23:00');
  });

  it('holds the signal steady where you stand and drifts as you cross town', () => {
    expect(signalBars(0, 0)).toBe(signalBars(0, 0));
    for (const [x, z] of [[0, 0], [500, -900], [-2_400, 1_800], [12_000, 12_000]]) {
      expect(signalBars(x, z)).toBeGreaterThanOrEqual(1);
      expect(signalBars(x, z)).toBeLessThanOrEqual(4);
    }
    const samples = new Set(
      Array.from({ length: 40 }, (_, step) => signalBars(step * 220, step * 140)),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('sending a preset', () => {
  it('appends the sent phrase to the inbox, already read', () => {
    const after = sendPreset([], PHONE_PRESETS[0], 12, 0);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ from: SENT_FROM, body: PHONE_PRESETS[0].body, at: 12, read: true });
  });

  it('gives each send its own id', () => {
    const first = sendPreset([], PHONE_PRESETS[0], 0, 0);
    const second = sendPreset(first, PHONE_PRESETS[0], 1, 1);
    expect(second[0].id).not.toBe(second[1].id);
  });

  it('goes through the same inbox cap and ordering as an arrival', () => {
    const inbox = Array.from({ length: INBOX_CAPACITY }, (_, index) => ({
      id: `old-${index}`, from: 'X', body: 'x', at: 0, read: true,
    }));
    const after = sendPreset(inbox, PHONE_PRESETS[0], 5, 0);
    expect(after).toHaveLength(INBOX_CAPACITY);
    expect(after[0].from).toBe(SENT_FROM);
  });
});

describe('forest rave invite (backlog item 11)', () => {
  it('holds the invite back until its window and sends it exactly once', () => {
    const random = createRandom(3);
    const schedule = createForestRaveSchedule(random, 0);
    expect(schedule.dueAt).toBeGreaterThan(140);
    expect(advanceForestRaveSchedule(schedule, schedule.dueAt - 1).message).toBeNull();

    const { message, schedule: next } = advanceForestRaveSchedule(schedule, schedule.dueAt);
    expect(message).not.toBeNull();
    expect(message!.id).toBe(FOREST_RAVE_MESSAGE_ID);
    expect(message!.body.toLowerCase()).toContain('skogsrave');
    expect(next.sent).toBe(true);

    expect(advanceForestRaveSchedule(next, next.dueAt + 10_000).message).toBeNull();
  });
});
