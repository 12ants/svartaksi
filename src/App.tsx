/**
 * Root UI shell for the Svartaksi preview: hosts the Three.js canvas (owned by
 * svartaksiRuntime) and the HUD chrome around it (speed readout, world/camera
 * settings panel, nearby-places box, teleport overlay, dev performance/log panels).
 * This component owns no rendering itself — it only reflects/drives runtime state.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createSvartaksiRuntime, type CameraMode, type InspectionHit, type NearbyItem, type SvartaksiRuntime, type PlayerMode, type RuntimeStatus } from './svartaksi/svartaksiRuntime';
import type { WorldSource } from './world/types';
import { loadRenderOptions, saveRenderOptions, type RenderOptions, type RenderQuality } from './world/renderOptions';
import { advanceTimeOfDay } from './world/timeOfDay';
import { loadUserSettings, saveUserSettings, type UserSettings } from './svartaksi/userSettings';
import { CAMERA_LABELS, CAMERA_MODES, nextCameraMode } from './svartaksi/cameraModes';
import {
  CAMERA_SETTING_BOUNDS, DEFAULT_CAMERA_SETTINGS, isDefaultCameraSettings, type CameraSettings,
} from './svartaksi/cameraSettings';
import { HudReadout } from './components/HudReadout';
import { HudAnnounce } from './components/HudAnnounce';
import { HudSpeech, type SpeechLine } from './components/HudSpeech';
import { TimeOfDayBar } from './components/TimeOfDayBar';
import { formatClock } from './svartaksi/formatClock';
// Both overlays pull in maplibre-gl, which the rest of the game never touches — the
// renderer only ever consumes vector tiles as data (see README "Where the world comes
// from"). Deferring the import keeps that ~200kB out of the bundle the player waits on
// at first paint and only fetches it when the map or bus planner is actually opened.
const OverMap = lazy(async () => ({ default: (await import('./components/OverMap')).OverMap }));
const BusOverMap = lazy(async () => ({ default: (await import('./components/BusOverMap')).BusOverMap }));
import type { LngLat, LocalPoint } from './world/types';
import { START_LOCATION } from './svartaksi/config';
import { lngLatToLocal } from './world/geo';
import { WorldInspectorPanel } from './components/WorldInspectorPanel';
import { WorldLoading } from './components/WorldLoading';
import { useHudVisibility } from './hooks/useHudVisibility';
import { useOverlayController } from './hooks/useOverlayController';
import { useFullscreen } from './hooks/useFullscreen';
import { HudActions } from './components/HudActions';
import { DevToolsPanel } from './components/DevToolsPanel';
import { DevPerfPanel } from './components/DevPerfPanel';
import { DevGameLogPanel } from './components/DevGameLogPanel';
import { DevStatePanel } from './components/DevStatePanel';
import { installConsoleCapture, pushLog } from './svartaksi/gameLogger';
import { Phone, PhoneToast } from './components/Phone';
import {
  addToInbox,
  advanceForestRaveSchedule,
  advanceMysteriousSchedule,
  advanceSmsSchedule,
  createForestRaveSchedule,
  createMysteriousSchedule,
  createRandom,
  createSmsSchedule,
  markRead,
  MONKEY_CAGE_REVEAL_ID,
  sendPreset,
  unreadCount,
  type ForestRaveSchedule,
  type MysteriousSchedule,
  type PhoneMessage,
  type PhonePreset,
  type SmsSchedule,
} from './svartaksi/phone';
import { LOADING_VERSES } from './svartaksi/loadingPoetry';
import { createStoryRuntime, setFlag } from './story/storyRuntime';
import {
  loadStoryEngineFromStorage,
  saveStoryEngineToStorage,
  stepStoryEngine,
  type QuestLogEntry,
} from './story/storyEngine';
import svartaksiOpeningProject from './story/projects/svartaksi-opening.json';
import type { StoryProject } from './story/types';
import { CAMP_LOCATION } from './svartaksi/bonfireCamp';
import { HudVisibilityMenu } from './components/HudVisibilityMenu';
import { TouchControls } from './components/TouchControls';
import { useDialogFocus } from './hooks/useDialogFocus';
import { installPerformanceBridge } from './performance/installPerformanceBridge';
import { resetSvartaksiStorage } from './svartaksi/resetGame';
import { ResetConfirmDialog } from './components/ResetConfirmDialog';
import { isDevModeRequested } from './svartaksi/devMode';

const QUALITIES: Array<{ value: RenderQuality; label: string }> = [
  { value: 'performance', label: 'Performance' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High' },
];
// Quality tier, camera mode and time of day are the player surface — visible on every
// load. Physics wireframe, the performance monitor and game log, per-surface toggles and
// the terrain sliders live in the developer tools panel.
const QUALITY_OPTIONS: Array<{
  key: keyof Pick<
    RenderOptions,
    'cinematicMaterials' | 'highQualityShadows' | 'streetLights' | 'facadeDetails'
    | 'dynamicResolution'
  >;
  label: string;
}> = [
  { key: 'cinematicMaterials', label: 'Cinematic materials' },
  { key: 'highQualityShadows', label: 'High-quality shadows' },
  { key: 'streetLights', label: 'Street lights' },
  { key: 'facadeDetails', label: 'Facade details' },
  { key: 'dynamicResolution', label: 'Dynamic resolution' },
];
// The story projects evaluated live by item 11's engine. Just svartaksi-opening for now —
// a second authored project (e.g. item 15's stable quest) would simply join this array.
const STORY_PROJECTS: readonly StoryProject[] = [svartaksiOpeningProject as unknown as StoryProject];
// Where 'ryssbergen-camp', the one authored place svartaksi-opening uses, actually is in
// local space — resolved once since START_LOCATION/CAMP_LOCATION never move at runtime.
const STORY_PLACES: Readonly<Record<string, LocalPoint>> = {
  'ryssbergen-camp': lngLatToLocal(START_LOCATION, CAMP_LOCATION),
};
const resolveStoryPlace = (placeId: string): LocalPoint | null => STORY_PLACES[placeId] ?? null;

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SvartaksiRuntime | null>(null);
  // WorldSource has one live value, so this never changes at runtime — kept as state
  // rather than a constant because it still flows through onStatus, the pipeline
  // readout and the runtime the same way a selectable source would.
  const [source] = useState<WorldSource>('maplibre');
  // Read once at mount: same shape as installPerformanceBridge's ?perfCapture=1 gate,
  // and re-checking it on navigation would let the developer surface flicker on a
  // client-side route change that never happens in this app anyway.
  const [devMode] = useState(() => isDevModeRequested(window.location.search));
  const [renderOptions, setRenderOptions] = useState<RenderOptions>(() => loadRenderOptions(localStorage));
  const [settings, setSettings] = useState<UserSettings>(() => loadUserSettings(localStorage));
  const startupSourceRef = useRef(source);
  const startupRenderOptionsRef = useRef(renderOptions);
  const startupSettingsRef = useRef(settings);
  const [speed, setSpeed] = useState(0);
  const [fps, setFps] = useState(0);
  const [area, setArea] = useState<string | null>(null);
  const cameraMode = settings.cameraMode;
  const camera = settings.camera;
  const cameraIsDefault = isDefaultCameraSettings(camera);
  const blobControlScheme = settings.blobControlScheme;
  const timeOfDay = settings.timeOfDay;
  const showNearby = settings.showNearby;
  const showDevPerf = settings.showDevPerf;
  const showDevLog = settings.showDevLog;
  const showDevState = settings.showDevState;
  // Mirrors of state read inside the mount-only keydown effect below, which would
  // otherwise close over stale values — refs always read fresh regardless of when
  // the closure was created.
  const cameraModeRef = useRef(cameraMode);
  const blobControlSchemeRef = useRef(blobControlScheme);
  const showDevPerfRef = useRef(showDevPerf);
  const chooseCameraRef = useRef<(next: CameraMode) => void>(() => {});
  const toggleBlobControlSchemeRef = useRef<() => void>(() => {});
  const [nearby, setNearby] = useState<NearbyItem[]>([]);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [flashlight, setFlashlight] = useState(false);
  const [inbox, setInbox] = useState<PhoneMessage[]>([]);
  /** The message currently flashing across the middle of the screen. Cleared on a timer
   * rather than by the player: it is a glance, not a notification to dismiss. */
  const [arrival, setArrival] = useState<PhoneMessage | null>(null);
  /** Where the player is, for the phone's signal meter. Sampled on the same slow tick as
   * the rest of the HUD rather than per frame. */
  const [playerAt, setPlayerAt] = useState<LocalPoint>({ x: 0, z: 0 });
  const smsScheduleRef = useRef<SmsSchedule | null>(null);
  // Seeded once per session: the ad run is then reproducible for as long as the page
  // lives, which is what makes the schedule testable at all (see phone.ts).
  const smsRandomRef = useRef<(() => number) | null>(null);
  // The infinite_monkey_cage hook: a separate schedule and PRNG stream from the ad
  // ticker's, so mixing the two never perturbs either one's reproducible draw order.
  const mysteriousScheduleRef = useRef<MysteriousSchedule | null>(null);
  const mysteriousRandomRef = useRef<(() => number) | null>(null);
  // The minimal story-flag store item 15 introduced (src/story/storyRuntime.ts) is
  // reused here rather than duplicated: the reveal text sets 'monkey-cage:contacted' the
  // same way a stable visit sets 'stable:visited', ahead of item 11's full runtime.
  const storyRuntimeRef = useRef(createStoryRuntime());
  // Item 11's real story engine (src/story/storyEngine.ts): evaluates STORY_PROJECTS'
  // triggers live and keeps a quest log the phone's notes screen reads. Loaded once from
  // localStorage so quest progress survives a reload, same convention as renderOptions
  // and userSettings above.
  const [initialStoryEngine] = useState(() => loadStoryEngineFromStorage(localStorage));
  const storyEngineRef = useRef(initialStoryEngine);
  const [questLog, setQuestLog] = useState<QuestLogEntry[]>(() => initialStoryEngine.questLog);
  const [storyFlags, setStoryFlags] = useState<string[]>(() => [...initialStoryEngine.runtime.flags]);
  // The forest-rave mission trigger's own schedule and PRNG stream, same shape as the
  // mysterious/ad tickers above — a separate stream so it never perturbs their draws.
  const forestRaveScheduleRef = useRef<ForestRaveSchedule | null>(null);
  const forestRaveRandomRef = useRef<(() => number) | null>(null);
  // How many presets the player has sent this session, which is also what makes each
  // sent message's id unique — see sendPreset in phone.ts.
  const sentCountRef = useRef(0);
  const handleSendPreset = useCallback((preset: PhonePreset) => {
    const at = performance.now() / 1000;
    setInbox((current) => sendPreset(current, preset, at, sentCountRef.current++));
  }, []);
  useEffect(() => { runtimeRef.current?.setFlashlight(flashlight); }, [flashlight]);

  /**
   * The junk-SMS ticker. One second is far finer than the gaps involved, and doing it on
   * an interval rather than per frame keeps the whole HUD out of the render loop.
   */
  useEffect(() => {
    // Seeded here rather than at construction because a clock read is not something a
    // render may do — and the effect runs once, which is exactly the lifetime wanted.
    const random = smsRandomRef.current ?? createRandom((Date.now() ^ 0x9e3779b9) >>> 0);
    smsRandomRef.current = random;
    const startedAt = performance.now();
    smsScheduleRef.current = createSmsSchedule(random, 0);

    const mysteriousRandom = mysteriousRandomRef.current ?? createRandom((Date.now() ^ 0x1eaf1eaf) >>> 0);
    mysteriousRandomRef.current = mysteriousRandom;
    mysteriousScheduleRef.current = createMysteriousSchedule(mysteriousRandom, LOADING_VERSES.length, 0);

    const forestRaveRandom = forestRaveRandomRef.current ?? createRandom((Date.now() ^ 0x5eed5eed) >>> 0);
    forestRaveRandomRef.current = forestRaveRandom;
    forestRaveScheduleRef.current = createForestRaveSchedule(forestRaveRandom, 0);

    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const { message, schedule } = advanceSmsSchedule(smsScheduleRef.current!, elapsed, random);
      smsScheduleRef.current = schedule;

      const mysterious = advanceMysteriousSchedule(mysteriousScheduleRef.current!, elapsed, mysteriousRandom, LOADING_VERSES);
      mysteriousScheduleRef.current = mysterious.schedule;
      if (mysterious.message?.id === MONKEY_CAGE_REVEAL_ID) setFlag(storyRuntimeRef.current, 'monkey-cage:contacted');

      const forestRave = advanceForestRaveSchedule(forestRaveScheduleRef.current!, elapsed);
      forestRaveScheduleRef.current = forestRave.schedule;

      const arrived = message ?? mysterious.message ?? forestRave.message;
      const here = runtimeRef.current?.getPlayerLngLat();
      const localHere = here ? lngLatToLocal(START_LOCATION, here) : null;

      // Step item 11's story engine every tick, not just when a message lands — near-place
      // beats (e.g. meeting the bonfire) have nothing to do with the phone at all.
      const { unlocked } = stepStoryEngine(storyEngineRef.current, STORY_PROJECTS, {
        at: elapsed,
        phoneMessageIds: forestRave.message ? [forestRave.message.id] : [],
        playerPosition: localHere,
        resolvePlace: resolveStoryPlace,
      });
      if (unlocked.length > 0) {
        setQuestLog([...storyEngineRef.current.questLog]);
        setStoryFlags([...storyEngineRef.current.runtime.flags]);
        saveStoryEngineToStorage(localStorage, storyEngineRef.current);
        if (devMode) for (const item of unlocked) pushLog('info', 'story', item.beat.title);
      }

      if (localHere) setPlayerAt(localHere);
      if (!arrived) return;
      // All three schedules run off the same one-second tick, so a rare coincidence could
      // have more than one due in the same call — fold every arrival into the inbox
      // rather than dropping any.
      setInbox((current) => {
        let next = current;
        if (message) next = addToInbox(next, message);
        if (mysterious.message) next = addToInbox(next, mysterious.message);
        if (forestRave.message) next = addToInbox(next, forestRave.message);
        return next;
      });
      setArrival(arrived);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [devMode]);
  /** Where the bus planner starts from — the player's position, captured when the
   * overlay opens. See handleBusAction. */
  const [busStart, setBusStart] = useState<LngLat>(START_LOCATION);
  const [status, setStatus] = useState<RuntimeStatus>({
    source,
    phase: 'loading',
    mode: 'initial',
    progress: 0,
    message: 'Starting Three.js world',
    retryable: false,
  });
  const [inspectorEnabled, setInspectorEnabled] = useState(false);
  const [inspectionHit, setInspectionHit] = useState<InspectionHit | null>(null);
  // What the player currently is. The runtime is the authority — it changes this on
  // its own when a bus reaches the end of its route — and announces every change
  // through onMode, which is the single place this mirror is written.
  const [mode, setMode] = useState<PlayerMode>('car');
  const [hint, setHint] = useState<string | null>(null);
  /** The last line said to the player. Stamped with a sequence number because a speaker's
   * lines wrap, and the same sentence twice running is two events — see HudSpeech. */
  const [speech, setSpeech] = useState<SpeechLine | null>(null);
  const speechSeqRef = useRef(0);
  // Same stale-closure reason as cameraModeRef: the keydown effect below is
  // mount-only and must read the current mode/overlay state, not the first render's.
  const modeRef = useRef<PlayerMode>('car');
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);
  /** A patch over the camera dials — one field from a slider, or the whole set from the
   * reset button, which is the same operation with every field supplied. */
  const updateCamera = useCallback((patch: Partial<CameraSettings>) => {
    setSettings((current) => ({ ...current, camera: { ...current.camera, ...patch } }));
  }, []);
  const riding = mode === 'bus';
  const { visibility, setRegion, toggleAll } = useHudVisibility();
  const { isFullscreen, supported: fullscreenSupported, toggleFullscreen } = useFullscreen();
  const releaseInput = useCallback(() => {
    runtimeRef.current?.releaseInputSource('keyboard');
    runtimeRef.current?.releaseInputSource('touch');
    runtimeRef.current?.releaseBlobPointer();
  }, []);
  const { activeOverlay, open: openOverlay, close: closeOverlay, toggle: toggleOverlay } =
    useOverlayController(releaseInput);
  const worldDialogRef = useRef<HTMLElement>(null);
  useDialogFocus(worldDialogRef, closeOverlay, activeOverlay === 'world');
  const devDialogRef = useRef<HTMLElement>(null);
  useDialogFocus(devDialogRef, closeOverlay, activeOverlay === 'dev');

  useEffect(() => {
    if (!hostRef.current) return;
    const performanceBridge = installPerformanceBridge();
    const runtime = createSvartaksiRuntime({
      host: hostRef.current,
      onStatus: (status) => {
        setStatus(status);
        if (devMode) pushLog(status.phase === 'error' ? 'error' : 'info', 'world', `${status.phase}: ${status.message}`);
      },
      onSpeed: setSpeed,
      onFps: setFps,
      onArea: setArea,
      onNearby: setNearby,
      // Fires for arrival and for an explicit stopBusRide alike, so this is the one
      // place the mode mirror is written — no polling of getMode() needed.
      onMode: (next) => {
        setMode(next);
        if (devMode) pushLog('info', 'mode', `now ${next}`);
      },
      // The runtime changes the camera itself when a bus ride starts or ends, so this is
      // what keeps the persisted choice honest without polling.
      onCameraMode: (next) => {
        updateSettings({ cameraMode: next });
        if (devMode) pushLog('info', 'camera', next);
      },
      onHint: setHint,
      onSpeech: (line) => {
        speechSeqRef.current += 1;
        setSpeech(line === null ? null : { text: line, id: speechSeqRef.current });
      },
      onInspection: setInspectionHit,
    });
    runtimeRef.current = runtime;
    performanceBridge?.setRuntime(runtime);
    runtime.setRenderOptions(startupRenderOptionsRef.current);
    runtime.setCameraMode(startupSettingsRef.current.cameraMode);
    // Applied at startup alongside the mode, not left to the effect above: that effect
    // fires on mount too, but the runtime has to open on the framing the player saved
    // rather than on the defaults for a frame.
    runtime.setCameraSettings(startupSettingsRef.current.camera);
    runtime.setSource(startupSourceRef.current);
    return () => {
      performanceBridge?.dispose();
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [devMode, updateSettings]);

  useEffect(() => {
    if (!devMode) return;
    pushLog('info', 'load', `settings restored (camera ${startupSettingsRef.current.cameraMode})`);
    pushLog('info', 'load', `render options restored (quality ${startupRenderOptionsRef.current.quality})`);
    pushLog('info', 'load', `story engine restored (${initialStoryEngine.questLog.length} beats unlocked)`);
    return installConsoleCapture();
  }, [devMode, initialStoryEngine]);

  // Set just before a reset deletes storage, so the debounced save below and its
  // pagehide flush do not race the deletion and write the settings straight back.
  const resettingRef = useRef(false);

  /**
   * Persisted on a delay rather than on every change: when the sky is cycling, timeOfDay
   * is rewritten several times a second, and each of those would otherwise be a
   * synchronous localStorage write.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (resettingRef.current) return;
      saveUserSettings(localStorage, settings);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings]);

  // ...but a change made inside that window still has to survive leaving the page, which
  // is exactly when the pending write would otherwise be cancelled and lost.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    const flush = () => {
      if (resettingRef.current) return;
      saveUserSettings(localStorage, settingsRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const confirmReset = useCallback(() => {
    resettingRef.current = true;
    const { failed } = resetSvartaksiStorage(localStorage);
    if (failed.length > 0) {
      // Persistence is best-effort elsewhere in this app; surfacing a failed deletion
      // here is the one place the backlog asks for it to be reported rather than
      // silently swallowed, since the reset would otherwise look like it worked.
      window.alert(`Could not reset: ${failed.join(', ')}`);
      resettingRef.current = false;
      return;
    }
    window.location.reload();
  }, []);

  useEffect(() => { runtimeRef.current?.setTimeOfDay(timeOfDay); }, [timeOfDay]);
  useEffect(() => { runtimeRef.current?.setCameraMode(cameraMode); }, [cameraMode]);
  useEffect(() => { runtimeRef.current?.setCameraSettings(camera); }, [camera]);
  useEffect(() => { runtimeRef.current?.setBlobControlScheme(blobControlScheme); }, [blobControlScheme]);

  /**
   * Steps the clock rather than animating it per frame: a 200ms step is 1.2 minutes of
   * sky at the cycle rate, far below what reads as a jump, and it keeps the whole HUD
   * from re-rendering sixty times a second just to move the sun.
   */
  useEffect(() => {
    if (!settings.autoTimeOfDay) return;
    const stepMs = 200;
    const timer = window.setInterval(
      () => setSettings((current) => ({
        ...current,
        timeOfDay: advanceTimeOfDay(current.timeOfDay, stepMs / 1000),
      })),
      stepMs,
    );
    return () => window.clearInterval(timer);
  }, [settings.autoTimeOfDay]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'p' && devMode) updateSettings({ showDevPerf: !showDevPerfRef.current });
      if (key === 'z') toggleAll();
      if (key === 'o') {
        setInspectorEnabled((enabled) => !enabled);
      }
      if (event.key === 'Escape') {
        setInspectorEnabled(false);
        setPhoneOpen(false);
        return;
      }
      if (key === 'b') {
        if (modeRef.current === 'bus') {
          // No setMode here: stopBusRide brings the bus in and sets the player down,
          // which fires onMode — the single path that updates the mirror, for both
          // an early exit and a natural arrival.
          runtimeRef.current?.stopBusRide();
          return;
        }
        toggleOverlay('bus');
      }
      // Get in or out of the car. A no-op in the bus, or on foot out of range — the
      // runtime owns that test and answers by (not) firing onMode.
      // Skipped in freecam, where E is already bound to flying upward.
      if (key === 'e' && cameraModeRef.current !== 'freecam') runtimeRef.current?.toggleVehicle();
      // G swaps between the pill and the blob character, in place. A no-op outside
      // foot/blob (the runtime owns that test, same as E does for the car).
      if (key === 'g') runtimeRef.current?.toggleBlobForm();
      // V swaps the blob's own input scheme between this project's usual direct WASD
      // mapping and blobby's camera-relative click-to-move (see playerInput.ts's
      // BlobControlScheme). Persisted like the camera mode; only meaningful in blob
      // mode, but harmless to press anywhere else.
      if (key === 'v' && modeRef.current === 'blob') toggleBlobControlSchemeRef.current();
      // C walks the whole camera list in order rather than flipping between freecam and
      // whatever you were in before — every view is now reachable from the keyboard, and
      // freecam is simply the last stop on the way round.
      if (key === 'c') chooseCameraRef.current(nextCameraMode(cameraModeRef.current));
      // The phone. T opens and closes it; F works the torch whether or not it is open,
      // because fumbling a menu open to find a light is exactly what you do not want to
      // be doing on an unlit street.
      if (key === 't') setPhoneOpen((open) => !open);
      if (key === 'f') setFlashlight((on) => !on);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [devMode, toggleAll, toggleOverlay, updateSettings]);

  useEffect(() => { cameraModeRef.current = cameraMode; }, [cameraMode]);
  useEffect(() => { blobControlSchemeRef.current = blobControlScheme; }, [blobControlScheme]);
  useEffect(() => { showDevPerfRef.current = showDevPerf; }, [showDevPerf]);
  useEffect(() => {
    runtimeRef.current?.setInspectorEnabled(inspectorEnabled);
  }, [inspectorEnabled]);
  useEffect(() => {
    runtimeRef.current?.setInputPaused(activeOverlay !== null);
  }, [activeOverlay]);

  const updateRenderOptions = (next: RenderOptions) => {
    setRenderOptions(next);
    saveRenderOptions(localStorage, next);
    runtimeRef.current?.setRenderOptions(next);
  };

  // The runtime call happens in the effect that watches settings.cameraMode, so this is
  // only the state change — and the same path serves the panel, the C key and touch.
  const chooseCamera = useCallback(
    (next: CameraMode) => updateSettings({ cameraMode: next }),
    [updateSettings],
  );
  useEffect(() => { chooseCameraRef.current = chooseCamera; }, [chooseCamera]);

  // Swaps the blob's input scheme between this project's usual direct WASD mapping and
  // blobby's camera-relative drag-to-move (see playerInput.ts's BlobControlScheme).
  // Persisted like the camera mode, and — like chooseCamera above — one path shared by
  // the V key and the touch button, so the two can never disagree about what a toggle
  // means.
  const toggleBlobControlScheme = useCallback(
    () => updateSettings({ blobControlScheme: blobControlSchemeRef.current === 'blobby' ? 'direct' : 'blobby' }),
    [updateSettings],
  );
  useEffect(() => { toggleBlobControlSchemeRef.current = toggleBlobControlScheme; }, [toggleBlobControlScheme]);

  const inspectHere = useCallback(() => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (rect) {
      runtimeRef.current?.setInspectorPointer(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
    }
  }, []);
  const cycleCamera = useCallback(
    () => chooseCamera(nextCameraMode(cameraModeRef.current)),
    [chooseCamera],
  );
  const handleBusAction = useCallback((trigger?: HTMLElement | null) => {
    if (modeRef.current === "bus") {
      runtimeRef.current?.stopBusRide();
      if (devMode) pushLog('info', 'bus', 'ride stopped');
    } else {
      // Snapshot where the player is at the moment the planner opens, so the pin
      // it starts from is a fixed point rather than one that drifts on re-render.
      setBusStart(runtimeRef.current?.getPlayerLngLat() ?? START_LOCATION);
      openOverlay("bus", trigger);
    }
  }, [openOverlay, devMode]);

  return (
    <main className="svartaksi-shell">
      <div
        ref={hostRef}
        data-testid="three-world"
        className="three-world"
        onPointerMove={(event) => {
          if (inspectorEnabled) runtimeRef.current?.setInspectorPointer(event.clientX, event.clientY);
          if (mode === 'blob' && event.buttons !== 0) {
            runtimeRef.current?.setBlobPointer(event.clientX, event.clientY);
          }
        }}
        onPointerDown={(event) => {
          if (mode !== 'blob') return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          runtimeRef.current?.setBlobPointer(event.clientX, event.clientY);
        }}
        onPointerUp={() => runtimeRef.current?.releaseBlobPointer()}
        onPointerCancel={() => runtimeRef.current?.releaseBlobPointer()}
        onLostPointerCapture={() => runtimeRef.current?.releaseBlobPointer()}
      />
      {visibility.status ? <HudReadout speed={speed} fps={fps} status={status} /> : null}
      <div className="sr-only" aria-live="polite">{status.message}</div>
      <WorldLoading status={status} onRetry={() => runtimeRef.current?.retryWorldLoad()} />
      {visibility.actions ? (
        <HudActions
          inspectorEnabled={inspectorEnabled}
          onWorld={(trigger) => openOverlay('world', trigger)}
          devMode={devMode}
          onDev={(trigger) => openOverlay('dev', trigger)}
          onMap={(trigger) => openOverlay('map', trigger)}
          onBus={handleBusAction}
          onInspector={() => setInspectorEnabled((enabled) => !enabled)}
          onRandomPlace={() => runtimeRef.current?.spawnRandomPlace()}
          onSpawnCar={() => runtimeRef.current?.spawnCar()}
          phoneOpen={phoneOpen}
          phoneUnread={unreadCount(inbox)}
          onPhone={() => setPhoneOpen((open) => !open)}
          fullscreenSupported={fullscreenSupported}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
      ) : null}

      <button
        type="button"
        className="hud-restore"
        aria-label="HUD visibility"
        aria-keyshortcuts="Z"
        aria-expanded={activeOverlay === 'hud'}
        onClick={(event) => toggleOverlay('hud', event.currentTarget)}
      >
        HUD
      </button>

      <div className={visibility.context && hint ? 'action-hint' : 'sr-only'} aria-live="polite">
        {hint ?? ''}
      </div>

      {visibility.controls ? <div className="control-hint">
        {riding ? (
          <><kbd>WASD</kbd><span>WALK</span><kbd>B</kbd><span>GET OFF</span><kbd>C</kbd><span>CAMERA · {CAMERA_LABELS[cameraMode].toUpperCase()}</span></>
        ) : (
          <>
            {cameraMode === 'freecam' ? (
              <>
                <kbd>WASD</kbd><span>FLY</span><kbd>ARROWS</kbd><span>LOOK</span>
                <kbd>SPACE</kbd><span>UP</span><kbd>Q</kbd><span>DOWN</span>
              </>
            ) : mode === 'foot' ? (
              <><kbd>WASD</kbd><span>WALK</span><kbd>SHIFT</kbd><span>RUN</span><kbd>E</kbd><span>ENTER CAR / MOUNT HORSE</span><kbd>G</kbd><span>BECOME BLOB</span></>
            ) : mode === 'blob' ? (
              // The V hint names the scheme currently in force, not the one V switches to
              // — "V / BLOBBY CONTROLS" read as though V were the way to turn them on even
              // while they already were. Same convention as the camera button's "currently".
              <><kbd>WASD</kbd><span>{blobControlScheme === 'blobby' ? 'MOVE (CAMERA-RELATIVE)' : 'WALK'}</span><kbd>SHIFT</kbd><span>RUN</span><kbd>DRAG</kbd><span>{blobControlScheme === 'blobby' ? 'LEAN AND GO' : 'CLICK TO MOVE'}</span><kbd>V</kbd><span>CONTROLS: {blobControlScheme === 'blobby' ? 'BLOBBY' : 'DIRECT'}</span><kbd>G</kbd><span>BACK TO NORMAL</span></>
            ) : mode === 'horse' ? (
              <><kbd>W</kbd><span>TROT</span><kbd>W+C</kbd><span>WALK</span><kbd>W+SHIFT</kbd><span>CANTER</span><kbd>AD</kbd><span>TURN</span><kbd>E</kbd><span>DISMOUNT</span></>
            ) : (
              <><kbd>WASD</kbd><span>DRIVE</span><kbd>SHIFT</kbd><span>BOOST</span><kbd>E</kbd><span>GET OUT</span></>
            )}
            <kbd>C</kbd><span>CAMERA · {CAMERA_LABELS[cameraMode].toUpperCase()}</span><kbd>B</kbd><span>BUS</span>
          </>
        )}
        <kbd>Z</kbd><span>HIDE HUD</span>
      </div> : null}

      {visibility.context && (
        <>
          <HudAnnounce area={area} nearby={showNearby ? nearby : []} />
          <HudSpeech speech={speech} />
        </>
      )}

      {/* The arrival is deliberately not gated on HUD visibility: it is the message
          itself, briefly, and hiding the HUD is about chrome rather than about events.
          It is suppressed while the phone is open, where you are already reading it. */}
      <PhoneToast message={!phoneOpen && settings.showSmsToast ? arrival : null} />
      <Phone
        open={phoneOpen}
        inbox={inbox}
        notes={questLog}
        flashlight={flashlight}
        timeOfDay={timeOfDay}
        position={playerAt}
        onClose={() => setPhoneOpen(false)}
        onToggleFlashlight={() => setFlashlight((on) => !on)}
        onRead={(id) => setInbox((current) => markRead(current, id))}
        onSend={handleSendPreset}
      />

      {visibility.status ? (
        <TimeOfDayBar
          hours={timeOfDay}
          auto={settings.autoTimeOfDay}
          onChange={(next) => updateSettings({ timeOfDay: next, autoTimeOfDay: false })}
          onToggleAuto={() => updateSettings({ autoTimeOfDay: !settings.autoTimeOfDay })}
        />
      ) : null}

      {activeOverlay === 'world' && (
        <section ref={worldDialogRef} className="world-panel" role="dialog" aria-modal="true" aria-label="World settings panel">
          <div className="panel-heading">
            <div><small>RENDER PIPELINE</small><h2>World render</h2></div>
            <button onClick={closeOverlay} aria-label="Close world settings">×</button>
          </div>
          <p>
            Live OpenStreetMap data via MapLibre vector tiles &mdash; no API token &mdash;
            decoded into one local world model that Three.js renders.
          </p>
          <h3 className="render-section-title">Camera</h3>
          <div className="camera-switch" role="group" aria-label="Camera mode">
            {CAMERA_MODES.map((value) => (
              <button
                key={value}
                aria-pressed={cameraMode === value}
                title={riding && value === 'cockpit' ? 'Passenger seat inside the bus' : undefined}
                onClick={() => chooseCamera(value)}
              >
                {CAMERA_LABELS[value]}
              </button>
            ))}
          </div>
          <div className="render-options">
            {/* One dial per row, each a transform on whichever body rig is active — see
                cameraSettings.ts for why these are relative rather than absolute metres.
                Each input spreads its own bounds, so a slider cannot offer a value
                normalizeCameraSettings would clamp away. */}
            <label className="render-slider">
              <span>Distance</span>
              <input
                type="range"
                aria-label="Camera distance"
                {...CAMERA_SETTING_BOUNDS.distance}
                value={camera.distance}
                onChange={(event) => updateCamera({ distance: Number(event.target.value) })}
              />
              <output>{camera.distance.toFixed(2)}x</output>
            </label>
            <label className="render-slider">
              <span>Pitch</span>
              <input
                type="range"
                aria-label="Camera pitch"
                {...CAMERA_SETTING_BOUNDS.pitch}
                value={camera.pitch}
                onChange={(event) => updateCamera({ pitch: Number(event.target.value) })}
              />
              <output>{camera.pitch > 0 ? `+${camera.pitch}` : camera.pitch}&deg;</output>
            </label>
            <label className="render-slider">
              <span>Response</span>
              <input
                type="range"
                aria-label="Camera responsiveness"
                {...CAMERA_SETTING_BOUNDS.responsiveness}
                value={camera.responsiveness}
                onChange={(event) => updateCamera({ responsiveness: Number(event.target.value) })}
              />
              <output>{Math.round(camera.responsiveness * 100)}%</output>
            </label>
            <label className="render-slider">
              <span>Field of view</span>
              <input
                type="range"
                aria-label="Camera field of view"
                {...CAMERA_SETTING_BOUNDS.fov}
                value={camera.fov}
                onChange={(event) => updateCamera({ fov: Number(event.target.value) })}
              />
              <output>{camera.fov}&deg;</output>
            </label>
            <div className="render-option">
              <span>Camera defaults</span>
              <button
                type="button"
                aria-label="Reset camera settings"
                disabled={cameraIsDefault}
                onClick={() => updateCamera(DEFAULT_CAMERA_SETTINGS)}
              >
                Reset
              </button>
            </div>
          </div>
          <h3 className="render-section-title">Sky</h3>
          <div className="render-option">
            <span>Cycle time of day</span>
            <button
              role="switch"
              aria-label="Cycle time of day automatically"
              aria-checked={settings.autoTimeOfDay}
              onClick={() => updateSettings({ autoTimeOfDay: !settings.autoTimeOfDay })}
            >
              {settings.autoTimeOfDay ? 'On' : 'Off'}
            </button>
          </div>
          <div className="render-option">
            <span>Time of day</span>
            <span className="time-of-day-readout">{formatClock(timeOfDay)}</span>
          </div>
          <h3 className="render-section-title">Information</h3>
          <div className="render-option">
            <span>Nearby areas &amp; POIs</span>
            <button role="switch" aria-label="Show nearby information" aria-checked={showNearby} onClick={() => updateSettings({ showNearby: !showNearby })}>{showNearby ? 'On' : 'Off'}</button>
          </div>
          <div className="render-option">
            <span>SMS &amp; message toasts</span>
            <button role="switch" aria-label="Show SMS and message toasts" aria-checked={settings.showSmsToast} onClick={() => updateSettings({ showSmsToast: !settings.showSmsToast })}>{settings.showSmsToast ? 'On' : 'Off'}</button>
          </div>
          <div className="render-option">
            <span>World inspector</span>
            <button
              role="switch"
              aria-label="Show world inspector"
              aria-checked={inspectorEnabled}
              onClick={() => setInspectorEnabled((enabled) => !enabled)}
            >
              {inspectorEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="render-option">
            <span>Random safe place</span>
            <button
              type="button"
              aria-label="Spawn at random open place"
              onClick={() => runtimeRef.current?.spawnRandomPlace()}
            >
              Spawn
            </button>
          </div>
          <div className="render-option">
            <span>Car</span>
            <button
              type="button"
              aria-label="Spawn a car"
              onClick={() => runtimeRef.current?.spawnCar()}
            >
              Spawn
            </button>
          </div>
          <h3 className="render-section-title">Quality</h3>
          <div className="quality-switch" role="group" aria-label="Render quality">
            {QUALITIES.map(({ value, label }) => (
              <button key={value} aria-pressed={renderOptions.quality === value}
                onClick={() => updateRenderOptions({ ...renderOptions, quality: value })}>
                {label}
              </button>
            ))}
          </div>
          <div className="render-options">
            {QUALITY_OPTIONS.map(({ key, label }) => (
              <div className="render-option" key={key}>
                <span>{label}</span>
                <button
                  role="switch"
                  aria-label={label}
                  aria-checked={renderOptions[key]}
                  onClick={() => updateRenderOptions({ ...renderOptions, [key]: !renderOptions[key] })}
                >
                  {renderOptions[key] ? 'On' : 'Off'}
                </button>
              </div>
            ))}
          </div>
          <dl className="pipeline-list">
            <div><dt>Map stack</dt><dd>MapLibre / OSM</dd></div>
            <div><dt>World state</dt><dd>{status.phase}</dd></div>
            <div><dt>Active source</dt><dd>{source}</dd></div>
          </dl>
          <h3 className="render-section-title">Editors</h3>
          <p>
            Author Studio holds the model editor, story editor and the procedural world
            editor used to build the geometry rendered here.
          </p>
          <a className="author-studio-link" href="/author/" target="_blank" rel="noopener noreferrer">
            Open Author Studio
          </a>
          <h3 className="render-section-title">Reset</h3>
          <div className="render-option">
            <span>Reset all settings and restart</span>
            <button type="button" aria-label="Reset all settings and restart" onClick={() => setResetConfirmOpen(true)}>
              Reset
            </button>
          </div>
        </section>
      )}

      {devMode && activeOverlay === 'dev' && (
        <DevToolsPanel
          renderOptions={renderOptions}
          onUpdateRenderOptions={updateRenderOptions}
          showDevPerf={showDevPerf}
          showDevLog={showDevLog}
          showDevState={showDevState}
          onUpdateSettings={updateSettings}
          onSpawnModel={(model) => (
            runtimeRef.current
              ? runtimeRef.current.spawnModel(model)
              : Promise.reject(new Error('world not ready'))
          )}
          onClearSpawnedModels={() => runtimeRef.current?.clearSpawnedModels() ?? 0}
          onTipLastSpawnedModel={() => runtimeRef.current?.tipLastSpawnedModel() ?? null}
          onClose={closeOverlay}
          panelRef={devDialogRef}
        />
      )}

      {devMode && showDevPerf && (
        <DevPerfPanel runtimeRef={runtimeRef} onClose={() => updateSettings({ showDevPerf: false })} />
      )}

      {devMode && showDevLog && (
        <DevGameLogPanel onClose={() => updateSettings({ showDevLog: false })} />
      )}

      {devMode && showDevState && (
        <DevStatePanel
          runtimeRef={runtimeRef}
          questLog={questLog}
          storyFlags={storyFlags}
          onClose={() => updateSettings({ showDevState: false })}
        />
      )}

      {resetConfirmOpen && (
        <ResetConfirmDialog onConfirm={confirmReset} onCancel={() => setResetConfirmOpen(false)} />
      )}

      {activeOverlay === 'map' && (
        <Suspense fallback={null}>
          <OverMap
            initialLng={START_LOCATION.lng}
            initialLat={START_LOCATION.lat}
            onSelect={(lng, lat) => {
              runtimeRef.current?.teleportTo(lng, lat);
              if (devMode) pushLog('info', 'teleport', `${lng.toFixed(4)}, ${lat.toFixed(4)}`);
              closeOverlay();
            }}
            onClose={closeOverlay}
          />
        </Suspense>
      )}

      {visibility.context && inspectorEnabled && (
        <WorldInspectorPanel
          hit={inspectionHit}
          touchMode={typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches}
          onInspectHere={inspectHere}
        />
      )}

      {activeOverlay === 'bus' && (
        <Suspense fallback={null}>
          <BusOverMap
            // Where the player is, not where the world starts: the planner pins its
            // start there and centers on it. Read once at open — BusOverMap captures
            // it, so driving on with the overlay up cannot move the pin.
            initialLng={busStart.lng}
            initialLat={busStart.lat}
            onGo={(path: LocalPoint[], signalStops) => {
              // Only mirror the ride state when the runtime confirms it began — a
              // start it rejected would otherwise leave the HUD stuck in "EXIT BUS"
              // with no way back, since stopBusRide no-ops when nothing is riding.
              // Nothing to mirror here: the runtime announces the new mode and the
              // seat camera through onMode/onCameraMode, and a failed start it rejects
              // announces neither — so a failed start leaves the HUD exactly as it was.
              runtimeRef.current?.startBusRide(path, signalStops);
              if (devMode) pushLog('info', 'bus', 'ride requested');
              closeOverlay();
            }}
            onClose={closeOverlay}
          />
        </Suspense>
      )}

      {activeOverlay === 'hud' ? (
        <HudVisibilityMenu
          visibility={visibility}
          onChange={setRegion}
          onClose={closeOverlay}
        />
      ) : null}

      {visibility.controls ? (
        <TouchControls
          mode={mode}
          cameraMode={cameraMode}
          inspectorEnabled={inspectorEnabled}
          onInput={(state) => runtimeRef.current?.setInputSourceState('touch', state)}
          onRelease={releaseInput}
          onInteract={() => runtimeRef.current?.toggleVehicle()}
          onToggleBlobForm={() => runtimeRef.current?.toggleBlobForm()}
          blobControlScheme={blobControlScheme}
          onToggleBlobControlScheme={toggleBlobControlScheme}
          onCamera={cycleCamera}
          onBus={() => handleBusAction()}
          onMenu={(trigger) => openOverlay('hud', trigger)}
          onInspectHere={inspectHere}
        />
      ) : null}
    </main>
  );
}
