/**
 * Verses shown on the loading screen.
 *
 * The world takes a few seconds to fetch and assemble, and a bare progress bar makes
 * that wait feel like a stall. A short poem gives the eye somewhere to go, and — since
 * the game opens on a night bus out of a commuter suburb — the register is deliberately
 * bleak rather than cheerful. All original text, so nothing here needs attribution.
 *
 * Kept as plain data with a pure picker so the component stays trivially testable: no
 * Math.random inside the render path, no module-level state that would make two mounts
 * disagree.
 */

export interface LoadingVerse {
  /** Two to four short lines. Rendered one per line, in order. */
  lines: readonly string[];
  /** Shown small underneath, as a byline would be. */
  title: string;
}

export const LOADING_VERSES: readonly LoadingVerse[] = [
  {
    title: 'Timetable',
    lines: [
      'The last bus keeps its promise',
      'the way a grave keeps yours:',
      'it arrives, and it takes you,',
      'and it does not ask where.',
    ],
  },
  {
    title: 'Commuter',
    lines: [
      'Every window is a small grey country',
      'and I have a visa for none of them.',
      'I ride to the end of the line',
      'to find out what the end looks like.',
    ],
  },
  {
    title: 'Streetlight',
    lines: [
      'The lamps come on in order,',
      'each one a little confession',
      'the dark has agreed to hear',
      'and then forget by morning.',
    ],
  },
  {
    title: 'Cold Front',
    lines: [
      'The city was built by people',
      'who believed in mornings.',
      'I have not met them.',
      'I have only met the concrete.',
    ],
  },
  {
    title: 'Passenger',
    lines: [
      'Nobody looks up on this route.',
      'We have all seen the same rain',
      'wear the same holes',
      'in the same tired hill.',
    ],
  },
  {
    title: 'Address',
    lines: [
      'Somewhere ahead there is a street',
      'with my name half-remembered on it.',
      'The bus knows the way.',
      'I have stopped asking how.',
    ],
  },
  {
    title: 'Water',
    lines: [
      'The bay lies flat as an unread letter.',
      'Whatever it wanted to say',
      'it said to the ice',
      'and the ice said nothing back.',
    ],
  },
  {
    title: 'Terminus',
    lines: [
      'There is no last stop, only',
      'the place the driver stops caring.',
      'Get off there. It is as good',
      'as anywhere to begin being lost.',
    ],
  },
  {
    title: 'Housing',
    lines: [
      'Nine floors of yellow light,',
      'nine hundred small refusals',
      'to go outside tonight.',
      'I count them like a rosary.',
    ],
  },
  {
    title: 'Winter Service',
    lines: [
      'Snow falls on the timetable',
      'and the timetable does not mind.',
      'It was never about the hours.',
      'It was about the waiting.',
    ],
  },
  {
    title: 'Bridge',
    lines: [
      'Halfway across, the town lets go',
      'and for four seconds you are nobody,',
      'suspended over black water,',
      'gloriously unaccounted for.',
    ],
  },
  {
    title: 'Interior',
    lines: [
      'The heater ticks. The window sweats.',
      'Someone has written a name',
      'in the fog and wiped it out',
      'before anyone could read it.',
    ],
  },
  {
    title: 'Forecast',
    lines: [
      'Grey, then grey, then briefly',
      'a colour we agreed to call blue,',
      'then grey again, and after that',
      'whatever we decide to survive.',
    ],
  },
  {
    title: 'Fare',
    lines: [
      'It costs what it costs.',
      'You pay it in evenings.',
      'The receipt is the streetlight',
      'sliding off your face.',
    ],
  },
  {
    title: 'Rush Hour',
    lines: [
      'Ten thousand people going home',
      'to rooms that did not miss them.',
      'The engine sighs at every stop.',
      'So do we. So does the door.',
    ],
  },
  {
    title: 'Krukmakargatan',
    lines: [
      'They named the street for potters',
      'who are all clay themselves now,',
      'fired and shelved and quietly',
      'holding nothing at all.',
    ],
  },
];

/**
 * A verse for one loading session. `seed` is any 0..1 value (a caller passes
 * `Math.random()`); keeping the randomness outside makes this deterministic to test and
 * lets the caller step through verses without re-rolling.
 */
export function pickLoadingVerse(seed: number): LoadingVerse {
  const safe = Number.isFinite(seed) ? Math.abs(seed) % 1 : 0;
  return LOADING_VERSES[Math.min(LOADING_VERSES.length - 1, Math.floor(safe * LOADING_VERSES.length))];
}
