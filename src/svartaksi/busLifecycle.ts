export type BusPhase =
  | 'hidden'
  | 'driving'
  | 'braking'
  | 'door-opening'
  | 'alighting'
  | 'waiting'
  | 'departing';

export interface BusLifecycleState {
  phase: BusPhase;
  phaseSeconds: number;
  alightProgress: number;
  departureMeters: number;
}

interface BusLifecycleInput {
  dt: number;
  speed: number;
  doorOpenFraction: number;
  stopReached: boolean;
  requestedStop: boolean;
  busOffscreen: boolean;
  requestedStart?: boolean;
}

const ALIGHT_SECONDS = 2.2;
const WAIT_SECONDS = 2.5;
const DEPARTURE_DISTANCE = 80;

export function createBusLifecycle(): BusLifecycleState {
  return {
    phase: 'hidden',
    phaseSeconds: 0,
    alightProgress: 0,
    departureMeters: 0,
  };
}

export function canRelocateWorld(state: BusLifecycleState): boolean {
  return state.phase === 'hidden';
}

function enterPhase(state: BusLifecycleState, phase: BusPhase): BusLifecycleState {
  return { ...state, phase, phaseSeconds: 0 };
}

export function advanceBusLifecycle(
  state: BusLifecycleState,
  input: BusLifecycleInput,
): BusLifecycleState {
  const dt = Math.max(0, input.dt);

  switch (state.phase) {
    case 'hidden':
      return input.requestedStart
        ? { ...createBusLifecycle(), phase: 'driving' }
        : createBusLifecycle();
    case 'driving':
      if (input.requestedStop || input.stopReached) return enterPhase(state, 'braking');
      return { ...state, phaseSeconds: state.phaseSeconds + dt };
    case 'braking':
      if (input.stopReached && input.speed <= 0.02) return enterPhase(state, 'door-opening');
      return { ...state, phaseSeconds: state.phaseSeconds + dt };
    case 'door-opening':
      if (input.doorOpenFraction >= 0.95) return enterPhase(state, 'alighting');
      return { ...state, phaseSeconds: state.phaseSeconds + dt };
    case 'alighting': {
      const alightProgress = Math.min(1, state.alightProgress + dt / ALIGHT_SECONDS);
      if (alightProgress >= 1) {
        return {
          ...enterPhase(state, 'waiting'),
          alightProgress: 1,
        };
      }
      return {
        ...state,
        phaseSeconds: state.phaseSeconds + dt,
        alightProgress,
      };
    }
    case 'waiting': {
      const phaseSeconds = state.phaseSeconds + dt;
      if (phaseSeconds >= WAIT_SECONDS) return enterPhase(state, 'departing');
      return { ...state, phaseSeconds };
    }
    case 'departing': {
      const departureMeters = state.departureMeters + Math.max(0, input.speed) * dt;
      if (departureMeters >= DEPARTURE_DISTANCE || input.busOffscreen) {
        return createBusLifecycle();
      }
      return {
        ...state,
        phaseSeconds: state.phaseSeconds + dt,
        departureMeters,
      };
    }
  }
}
