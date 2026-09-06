/**
 * The player's phone: what is in the inbox, and when the next piece of junk arrives.
 *
 * Framework-agnostic on purpose (no React, no THREE, no DOM), in the same spirit as
 * busRouting.ts — the interesting part here is the schedule, and a schedule you can only
 * exercise by waiting three minutes in a browser is a schedule nobody tests. Everything
 * takes the world clock as an argument and returns the next state, so a test can run an
 * afternoon of ad SMS in a loop.
 *
 * The phone is a 1997 candybar: a two-line-ish monochrome screen, an inbox, and a torch.
 * The ads are the period detail — unsolicited premium-rate junk was most of what a Nordic
 * phone number attracted by the late nineties, and the numbers below are deliberately
 * non-dialable nonsense.
 */

export interface PhoneMessage {
  id: string;
  from: string;
  body: string;
  /** World-clock seconds the message landed, from the same clock the signals run on. */
  at: number;
  read: boolean;
}

/** The junk. Written in the register of the era: shouted, abbreviated, and slightly
 * threatening about what it will cost you. */
export const AD_MESSAGES: ReadonlyArray<{ from: string; body: string }> = [
  { from: 'VINN-NU', body: 'GRATTIS! Du har vunnit en resa till Mallorca. Ring 0900-000 000. 25kr/min.' },
  { from: '72500', body: 'RINGSIGNALER! Nokia-toner 10kr/st. Skicka TON till 72500.' },
  { from: 'MOBIL-X', body: 'Ny mobil 1kr! Bindningstid 36 man. Svara JA for offert.' },
  { from: 'PIZZA-1', body: 'Familjepizza + 2L lask 79kr. Endast idag. Visa detta SMS.' },
  { from: 'KLUBB99', body: 'Fredag: 90-talsdisco pa Slussen. Fri entre fore 22.' },
  { from: 'LOGO-SMS', body: 'OPERATORSLOGGA till din telefon! 15kr. Skicka LOGO till 72500.' },
  { from: 'HOROSKOP', body: 'Vad sager stjarnorna? Ring astrologen. 0900-000 111.' },
  { from: 'BILTVATT', body: '3 tvattar for 2 hos Svartaksi Biltvatt. Erbjudandet galler t.o.m. sondag.' },
  { from: 'SL-INFO', body: 'Trafikstorning. Rakna med langre restid. Vi beklagar.' },
  { from: 'ABONNENT', body: 'Ditt kontantkort har 12kr kvar. Ladda pa narmaste kiosk.' },
  { from: 'RESA-99', body: 'Sista minuten Kanarieoarna 2495kr! Boka pa 0900-000 222.' },
  { from: 'DEJT-SMS', body: 'Nagon i din narhet vill chatta! Svara HEJ. 5kr/sms.' },
];

/**
 * mulberry32. A whole PRNG rather than Math.random because the schedule has to be
 * reproducible: a test that asserts "the second ad lands between 90 and 240 seconds after
 * the first" needs the same run every time, and the game gets its variety from the seed.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** How long after the world starts the first ad can arrive. Long enough that the opening
 * ride has actually begun and the player is looking at the city rather than a loading bar. */
const FIRST_AD_MIN_SECONDS = 45;
const FIRST_AD_MAX_SECONDS = 100;
/** And the gap between the ones after it. Junk SMS is an interruption; at a tighter
 * spacing it stops being one and becomes the weather. */
const AD_GAP_MIN_SECONDS = 100;
const AD_GAP_MAX_SECONDS = 260;
/** How many messages the inbox keeps. A phone of this era held a couple of dozen and
 * then started refusing them; this simply drops the oldest, which is kinder. */
export const INBOX_CAPACITY = 20;

export interface SmsSchedule {
  /** World-clock seconds the next ad is due. */
  dueAt: number;
  /** Index into AD_MESSAGES of the one that will arrive, chosen when the previous one
   * was scheduled so the same seed always produces the same run. */
  nextIndex: number;
  /** How many have been sent, which is also what makes each message id unique. */
  sent: number;
}

function pickGap(random: () => number, first: boolean): number {
  return first
    ? FIRST_AD_MIN_SECONDS + random() * (FIRST_AD_MAX_SECONDS - FIRST_AD_MIN_SECONDS)
    : AD_GAP_MIN_SECONDS + random() * (AD_GAP_MAX_SECONDS - AD_GAP_MIN_SECONDS);
}

export function createSmsSchedule(random: () => number, nowSeconds = 0): SmsSchedule {
  return {
    dueAt: nowSeconds + pickGap(random, true),
    nextIndex: Math.floor(random() * AD_MESSAGES.length) % AD_MESSAGES.length,
    sent: 0,
  };
}

/**
 * Whether an ad is due, and the schedule to carry forward.
 *
 * Returns at most one message per call even if the clock jumped past several gaps — a
 * backgrounded tab should not empty the whole ad bank into the inbox the moment it comes
 * back, and the next one is rescheduled from *now* rather than from when it was due, so
 * the queue drains rather than piling up.
 */
export function advanceSmsSchedule(
  schedule: SmsSchedule,
  nowSeconds: number,
  random: () => number,
): { message: PhoneMessage | null; schedule: SmsSchedule } {
  if (nowSeconds < schedule.dueAt) return { message: null, schedule };
  const ad = AD_MESSAGES[schedule.nextIndex % AD_MESSAGES.length];
  const message: PhoneMessage = {
    id: `ad-${schedule.sent}`,
    from: ad.from,
    body: ad.body,
    at: nowSeconds,
    read: false,
  };
  // The next index steps on rather than being drawn fresh, so a short session never
  // shows the same ad twice running.
  const step = 1 + Math.floor(random() * (AD_MESSAGES.length - 1));
  return {
    message,
    schedule: {
      dueAt: nowSeconds + pickGap(random, false),
      nextIndex: (schedule.nextIndex + step) % AD_MESSAGES.length,
      sent: schedule.sent + 1,
    },
  };
}

/** Newest first, capped, with the arrival at the head — which is the order the inbox is
 * read in and saves the UI sorting on every render. */
export function addToInbox(inbox: readonly PhoneMessage[], message: PhoneMessage): PhoneMessage[] {
  return [message, ...inbox].slice(0, INBOX_CAPACITY);
}

/**
 * A fixed, authored phrase the player can send. There is no text entry — this is a 1997
 * candybar with a numeric keypad, and the preset list is also what keeps sending
 * testable and story triggers matchable against a known `id` rather than free text.
 */
export interface PhonePreset {
  id: string;
  /** What the sent message shows as its body. */
  body: string;
}

export const PHONE_PRESETS: ReadonlyArray<PhonePreset> = [
  { id: 'on-my-way', body: 'Pa vag.' },
  { id: 'running-late', body: 'Blir sen, kor.' },
  { id: 'where-are-you', body: 'Var ar du?' },
  { id: 'call-me', body: 'Ring mig.' },
  { id: 'ok', body: 'OK.' },
];

/** Who sent messages appear from in the inbox — there is no real recipient, so the
 * outgoing thread reads as SKICKAT rather than pretending to be a contact. */
export const SENT_FROM = 'SKICKAT';

/**
 * Sends a preset phrase: builds the outgoing message (already read, since the player just
 * wrote it) and appends it to the inbox the same way an arrival does, so the message
 * history is one list rather than two.
 *
 * `nowSeconds` and `sent` come from the caller rather than being read internally, keeping
 * this pure and reproducible the same way advanceSmsSchedule is — a test can send the same
 * preset twice and get two distinct, deterministic ids.
 */
export function sendPreset(
  inbox: readonly PhoneMessage[],
  preset: PhonePreset,
  nowSeconds: number,
  sent: number,
): PhoneMessage[] {
  const message: PhoneMessage = {
    id: `sent-${sent}-${preset.id}`,
    from: SENT_FROM,
    body: preset.body,
    at: nowSeconds,
    read: true,
  };
  return addToInbox(inbox, message);
}

/**
 * The mysterious number: quest bait, not junk. Unlike AD_MESSAGES it does not read from a
 * fixed bank — it reads the loading screen's own poems (`loadingPoetry.ts`), sent one at a
 * time from an unlisted sender, then followed by a single reveal message that names the
 * `infinite_monkey_cage` quest. Reusing the loading verses rather than authoring a second
 * set of poetry means the two surfaces stay in one voice, and a player who read them on
 * the way in gets to recognise them on the way back.
 */
export const MYSTERIOUS_SENDER = 'OKANT NUMMER';
/** How many verses arrive before the reveal. Small on purpose: this is a hook, not the
 * whole quest, and the point is noticing a pattern in a handful of texts, not attrition. */
export const MYSTERIOUS_VERSE_COUNT = 5;
/** Stable id of the message that names the quest, so a story trigger can match on it
 * rather than on body text. */
export const MONKEY_CAGE_REVEAL_ID = 'monkey-cage-reveal';
const MONKEY_CAGE_REVEAL_BODY =
  'Ett rum fullt av apor med skrivmaskiner skulle till sist skriva allt. '
  + 'Du har last fem rader av det. Nagon har lst resten. — infinite_monkey_cage';

/** First text arrives well after the ad ticker has established the phone as a noisy
 * thing, so a message with no dial-back number reads as a deliberate anomaly rather than
 * more of the same. Gaps after that are wider than the ad gaps for the same reason. */
const MYSTERIOUS_FIRST_MIN_SECONDS = 240;
const MYSTERIOUS_FIRST_MAX_SECONDS = 420;
const MYSTERIOUS_GAP_MIN_SECONDS = 300;
const MYSTERIOUS_GAP_MAX_SECONDS = 600;

export interface MysteriousSchedule {
  dueAt: number;
  /** Fixed-length, seeded-shuffled selection of LOADING_VERSES indices — decided once at
   * creation so the sequence a given seed produces is reproducible end to end, the same
   * guarantee createSmsSchedule gives the ad run. */
  order: readonly number[];
  /** How many verses have gone out. Equal to order.length once every verse has been sent;
   * the call after that sends the reveal and flips `done`. */
  position: number;
  /** Set once the reveal has gone out. No further messages follow — this is a one-shot
   * hook, not a recurring ticker. */
  done: boolean;
}

function pickMysteriousGap(random: () => number, first: boolean): number {
  return first
    ? MYSTERIOUS_FIRST_MIN_SECONDS + random() * (MYSTERIOUS_FIRST_MAX_SECONDS - MYSTERIOUS_FIRST_MIN_SECONDS)
    : MYSTERIOUS_GAP_MIN_SECONDS + random() * (MYSTERIOUS_GAP_MAX_SECONDS - MYSTERIOUS_GAP_MIN_SECONDS);
}

/** Fisher-Yates over 0..count-1 using the caller's PRNG, so the same seed always produces
 * the same verse order (and therefore the same five poems) end to end. */
function shuffledIndices(count: number, random: () => number): number[] {
  const indices = Array.from({ length: count }, (_, index) => index);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

export function createMysteriousSchedule(
  random: () => number,
  verseCount: number,
  nowSeconds = 0,
): MysteriousSchedule {
  const order = shuffledIndices(verseCount, random).slice(0, Math.min(MYSTERIOUS_VERSE_COUNT, verseCount));
  return {
    dueAt: nowSeconds + pickMysteriousGap(random, true),
    order,
    position: 0,
    done: order.length === 0,
  };
}

/**
 * Advances the mysterious-number schedule exactly like `advanceSmsSchedule`: at most one
 * message per call, rescheduled from `nowSeconds` rather than from when it was due, so a
 * backgrounded tab does not dump the whole sequence at once.
 */
export function advanceMysteriousSchedule(
  schedule: MysteriousSchedule,
  nowSeconds: number,
  random: () => number,
  verses: ReadonlyArray<{ title: string; lines: readonly string[] }>,
): { message: PhoneMessage | null; schedule: MysteriousSchedule } {
  if (schedule.done || nowSeconds < schedule.dueAt) return { message: null, schedule };

  if (schedule.position < schedule.order.length) {
    const verse = verses[schedule.order[schedule.position]];
    const message: PhoneMessage = {
      id: `monkey-${schedule.position}`,
      from: MYSTERIOUS_SENDER,
      body: verse.lines.join(' '),
      at: nowSeconds,
      read: false,
    };
    const position = schedule.position + 1;
    return {
      message,
      schedule: {
        ...schedule,
        position,
        dueAt: nowSeconds + pickMysteriousGap(random, false),
        done: false,
      },
    };
  }

  const message: PhoneMessage = {
    id: MONKEY_CAGE_REVEAL_ID,
    from: MYSTERIOUS_SENDER,
    body: MONKEY_CAGE_REVEAL_BODY,
    at: nowSeconds,
    read: false,
  };
  return { message, schedule: { ...schedule, done: true } };
}

/**
 * The forest rave invite: item 11's mission-trigger text. One-shot, like the monkey-cage
 * reveal, but simpler — a single message rather than a build-up sequence, since the
 * point here is the trigger (a phone-message beat resolving to the authored bonfire
 * location) rather than another multi-part hook. Its id is what
 * `story/projects/svartaksi-opening.json`'s `forest-rave-invite` beat matches on.
 */
export const FOREST_RAVE_MESSAGE_ID = 'forest-rave-invite';
const FOREST_RAVE_SENDER = 'OKANT NUMMER';
const FOREST_RAVE_BODY = 'Skogsrave vid Ryssbergen ikvall. Elden ar redan tand. Kom.';
const FOREST_RAVE_MIN_SECONDS = 150;
const FOREST_RAVE_MAX_SECONDS = 320;

export interface ForestRaveSchedule {
  dueAt: number;
  sent: boolean;
}

export function createForestRaveSchedule(random: () => number, nowSeconds = 0): ForestRaveSchedule {
  return {
    dueAt: nowSeconds + FOREST_RAVE_MIN_SECONDS + random() * (FOREST_RAVE_MAX_SECONDS - FOREST_RAVE_MIN_SECONDS),
    sent: false,
  };
}

/** Same one-message-per-call, reschedule-from-now shape as `advanceSmsSchedule` and
 * `advanceMysteriousSchedule` — except there is nothing to reschedule to, since this
 * fires exactly once per session. */
export function advanceForestRaveSchedule(
  schedule: ForestRaveSchedule,
  nowSeconds: number,
): { message: PhoneMessage | null; schedule: ForestRaveSchedule } {
  if (schedule.sent || nowSeconds < schedule.dueAt) return { message: null, schedule };
  const message: PhoneMessage = {
    id: FOREST_RAVE_MESSAGE_ID,
    from: FOREST_RAVE_SENDER,
    body: FOREST_RAVE_BODY,
    at: nowSeconds,
    read: false,
  };
  return { message, schedule: { ...schedule, sent: true } };
}

export function unreadCount(inbox: readonly PhoneMessage[]): number {
  return inbox.reduce((count, message) => count + (message.read ? 0 : 1), 0);
}

export function markRead(inbox: readonly PhoneMessage[], id: string): PhoneMessage[] {
  return inbox.map((message) => (message.id === id ? { ...message, read: true } : message));
}

/**
 * The clock as the phone shows it: `HH:MM` from the world's own time of day, so the
 * screen agrees with the sky rather than with the machine it is running on.
 */
export function phoneClock(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const whole = Math.floor(wrapped);
  const minutes = Math.floor((wrapped - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Signal bars, 0-4. Derived from position so it drifts as you cross the city and holds
 * still when you do — a bar meter that flickered on its own would read as broken. */
export function signalBars(x: number, z: number): number {
  const wave = Math.sin(x / 380) + Math.cos(z / 290);
  return Math.max(1, Math.min(4, 3 + Math.round(wave)));
}
