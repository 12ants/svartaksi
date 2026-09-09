/**
 * Centralized, tunable gameplay/physics/camera values.
 *
 * These are the numbers a developer plausibly wants to nudge for feel or balance —
 * character speeds, camera easing, physics timing, offsets. Values that are structural
 * or derived (world-generation/location config, persisted user prefs, fallback labels,
 * one-off geometry constants) stay where they were defined; see svartaksiRuntime.tsx,
 * config.ts and userSettings.ts.
 *
 * This is a pure relocation of existing module-level constants: grouped here for
 * discoverability, not renamed in meaning.
 */

/** On-foot movement speeds and turn rates for the two playable pedestrian bodies. */
export const MOVEMENT = {
  personWalkSpeed: 3.1,
  personRunSpeed: 6.4,
  /** rad/s */
  personTurnRate: 2.6,
  /** Deliberately different from the person's: a lighter, quicker-turning pace so the
   * blob reads as its own body rather than the pill wearing a different mesh. */
  blobWalkSpeed: 2.4,
  blobRunSpeed: 5.6,
  /** rad/s */
  blobTurnRate: 3.4,
} as const;

/** Jump, crouch and climb for the on-foot pill and blob (backlog: physics/movement
 * wishlist item 3). One shared set of tunables for both playable on-foot bodies, since
 * they run the same vertical-motion and world-collision code path. */
export const CHARACTER = {
  /** Sphere collider radius used for the pill/blob-vs-world sweep-and-slide (task 1) —
   * matches the existing personBody collider's own radius. */
  radius: 0.42,
  /** Height, in meters, the collider's centre sits above the feet while standing. */
  standColliderHeight: 0.85,
  /** Same, while crouched — lower to match the crouch's shrunk profile. */
  crouchColliderHeight: 0.45,
  /** Upward speed given on a jump press, m/s. */
  jumpVelocity: 5.4,
  /** Downward acceleration applied while airborne, m/s^2. */
  gravity: 20,
  /** Movement-speed multiplier while crouch is held. */
  crouchSpeedMultiplier: 0.5,
  /** How close to the ground (vertically) the pill counts as landed. */
  groundSnapTau: 0.18,
  /** Obstacle top height, above the feet, that is mantled onto automatically instead of
   * blocking movement — a kerb or low wall, not a climb. */
  mantleHeight: 0.85,
  /** Vertical speed while scaling a marked-climbable surface (trees, building edges),
   * m/s. */
  climbSpeed: 1.6,
  /** How far above the current ground a climb may carry the pill before it is capped —
   * keeps "climb" scoped to a mantle-plus rather than unbounded free climbing. */
  maxClimbHeight: 6,
} as const;

/** Freecam flight, in m/s and radians. The unboosted speed is a brisk walk over the
 * rooftops — fast enough to cross a block without waiting, slow enough to line a shot
 * up. */
export const FREECAM = {
  speed: 28,
  boostSpeed: 90,
  /** Just under a right angle, so looking straight up or down never flips the horizon. */
  maxPitch: 1.5,
  /** Look rate in radians per second — a full turn in about 3.5s of held key. */
  lookSpeed: 1.8,
  /**
   * Longest frame the look integration will honour, in seconds. Aiming is integrated
   * against the real frame time rather than the physics-capped `dt` (see the freecam block
   * in svartaksiRuntime's useFrame), so this is the only thing standing between a multi-second
   * stall and the view spinning through a full revolution on the frame after it. Generous
   * enough that any frame a player would actually sit through is honoured in full.
   */
  maxLookStep: 0.25,
} as const;

/** Shadow-map "baking": how stale the frustum is allowed to get before the shadow pass
 * re-renders. See the shadow-recentre block in svartaksiRuntime's useFrame. */
export const SHADOW = {
  /** How far the (texel-snapped) shadow-frustum target has to drift from its last
   * committed position, in metres, before the shadow map is forced to re-render. Below
   * this the frustum — and the shadow pass — stays frozen ("baked") rather than
   * re-rendering every frame for sub-metre motion that no on-screen shadow would read
   * as movement. Comfortably above one shadow-map texel (a few centimetres at the
   * current extent/mapSize) so ordinary driving still updates every frame or two, and
   * well under a car length so a moving shadow never visibly lags its caster.
   */
  recentreThresholdMeters: 0.75,
} as const;

/** Follow-camera easing. */
export const CAMERA = {
  /**
   * Exponential time constant for the follow camera settling onto its target pose. Now
   * the *midpoint* of an adjustable range rather than the whole story — see
   * cameraSettings.ts's `cameraEaseTau`, which is built around this so the default
   * responsiveness reproduces exactly this feel.
   */
  easeTau: 0.45,
  /**
   * How far above the surface the follow camera is held, in metres. Chase and cinematic
   * both swing a boom that a rising slope, or the drop off the side of a bridge deck, can
   * put under the world — and a camera under the world sees the backs of its faces, which
   * reads as the shot going black. Roughly a head's clearance: enough to be clear of the
   * surface, small enough that a camera pushed up by it still frames the body.
   */
  groundClearance: 0.6,
  /**
   * Shortest the follow boom is ever pulled to when something solid stands between the
   * camera and what it is framing, in metres.
   *
   * A camera pulled all the way to its look target ends up inside the body it follows,
   * which reads as the shot collapsing rather than as a wall being avoided. At roughly
   * arm's length the body still fills the frame and the shot stays legible, so a camera
   * wedged into a corner clips a little instead of collapsing.
   */
  minBoomDistance: 1.2,
} as const;

/** Fixed-tick simulation timing and physics thresholds. */
export const SIMULATION = {
  /** Fixed tick for bus/car/person movement and bus-lifecycle timing — the parts of a
   * frame where a frame-rate-coupled dt would either teleport a fast-moving body through
   * geometry (a huge single step) or, if that step is capped, quietly run the world in
   * slow motion below ~20fps (real time keeps passing but the capped step no longer
   * covers it). Everything else in the frame — camera easing, fog, the flashlight, HUD
   * throttling — stays keyed to the real per-frame delta; only this always-consistent
   * 60Hz tick needs decoupling from render rate. See accumulateFixedSteps. */
  fixedDt: 1 / 60,
  /** Bounds catch-up after a stall (a backgrounded tab, a GC pause) to this many ticks
   * per real frame — about 133ms, down to ~7.5fps-equivalent — before the remainder is
   * dropped rather than owed to the next frame. Without a bound, a multi-second stall
   * would demand hundreds of ticks in one frame and the catch-up itself would take long
   * enough to cause the next stall. */
  maxCatchupSteps: 8,
  /** A positionally-driven body that moves further than this in one tick was teleported,
   * not driven, and arrives with no velocity. Comfortably above what a bus covers at
   * speed in a 60Hz tick (about 25cm) and far below any real relocation. */
  drivenBodyTeleport: 3,
  /** How far the physics wireframe overlay reaches from the player. Far enough to cover
   * everything that could be hit in the next few seconds, near enough that a forest's
   * worth of trunks does not overrun the overlay's fixed line budget. */
  debugRadius: 140,
} as const;

/** Pill fade-in and shadow-onset timing. */
export const PERSON_FADE = {
  /** Seconds the pill takes to fade in when it appears. */
  fadeSeconds: 0.9,
  /** How far into that fade the pill starts casting a shadow. Late, because a shadow map
   * has no notion of opacity: whatever casts, casts solid. */
  shadowFade: 0.85,
} as const;

/** Where the car sits relative to the bus stop, and where the pill lands relative to a
 * vehicle when alighting. */
export const CAR = {
  /** Where the car is waiting, relative to the point the bus set the player down: far
   * enough up the road to read as "parked over there", close enough to be in frame from
   * the stop. */
  pickupForward: 22,
  pickupSide: 3,
  /** Distance from the vehicle the pill is set down at when alighting. Doors on the
   * right of travel, since this world drives on the right. */
  alightSideOffset: 2.4,
} as const;

/** Bus stop placement and lane positioning. */
export const BUS = {
  /** Extra meters past the pure braking distance a requested bus stop is placed at, so
   * pressing B at a crawl still reads as pulling in rather than stopping dead. */
  stopMargin: 2,
  /** How far the bus sits left of the centreline it is routed along, in metres. Kept
   * under half a typical lane so it still reads as being on the road at every width the
   * world uses, from a 9m street up to an 18m motorway. */
  laneOffset: 1.9,
} as const;

/** The "blob" playable form's authored-asset scale and foot placement. */
export const BLOB_MODEL = {
  /** The GLB's raw rest pose stands about 2.4m tall in its own units — see the
   * bounding-box check this constant was tuned against. Scaled down to a believable
   * human height rather than the capsule's exact 1.66m, since "a different body" is the
   * point of this form. */
  scale: 0.73,
  /** The GLB's origin sits at the character's hip, not its feet like every procedural
   * model here — this is the local Y that plants its feet on `group.position.y`. */
  footOffsetY: 0,
} as const;

/** The horse: gait speeds, turn rate, and mount proximity. */
export const HORSE = {
  /** Metres per second at each gait. Speed comes from which gait the rider has chosen,
   * not from a throttle blended against a top speed the way the car works — a horse does
   * not have intermediate speeds within a gait the way an engine has intermediate RPM. */
  gaitSpeedMps: {
    stand: 0,
    walk: 1.6,
    trot: 4.2,
    canter: 7.5,
  } as Record<'stand' | 'walk' | 'trot' | 'canter', number>,
  /** How fast heading turns at speed, radians/second — a horse steers by leaning and
   * does not pivot in place, so turn rate is deliberately modest next to the car's. */
  turnRateRadPerS: 1.4,
  /** How close the player must be to mount, in metres — the same order of magnitude as
   * the car's enter-prompt proximity in svartaksiRuntime.tsx. */
  mountRangeMeters: 2.5,
  /** Where the horse is tied up relative to the bus stop, same convention as
   * CAR.pickupForward/pickupSide (see beginAutomaticAlight in svartaksiRuntime.tsx) — a
   * different spot from the car's so the two don't overlap once the car is re-enabled. */
  pickupForward: 14,
  pickupSide: -5,
  /** Distance from the horse the rider is set down at on dismount. Smaller than the
   * car's alightSideOffset — stepping off a horse is a shorter move than getting out of
   * a car door. */
  dismountSideOffset: 1.4,
} as const;

/** The "blobby" alternate control scheme for the blob (see playerInput.ts's
 * BlobControlScheme and blobControls.ts, which resolves it), ported from
 * docs/misc/blobby/src/components/CharacterController.jsx. */
export const BLOBBY = {
  /** How fast the camera's own orbit yaw turns in response to the turn axis (A/D, or a
   * held drag's x-offset), rad/s. blobby's own ROTATION_SPEED (0.087 rad/frame) at an
   * assumed 60fps is ~5.2 rad/s — expressed per second rather than per frame so it reads
   * the same at any frame rate.
   *
   * Lowered from that 5.2 because the prototype's number is only comfortable against an
   * analog mouse offset: on this project's keyboard the turn axis is a full +/-1 the
   * instant A or D goes down, and 5.2 rad/s is ~300 deg/s, which whips the view round
   * faster than the camera's own easing can follow. 3 rad/s is ~172 deg/s — brisk, still
   * arcade, and steerable. Raise it back to 5.2 to feel the prototype exactly. */
  cameraYawRateRadPerS: 3,
  /** Exponential time constant the character's own facing eases toward the direction
   * implied by the current movement input. blobby itself snapped this instantly
   * (lerpAngle's own t was hardcoded to 1); a short ease reads less like a glitch on a
   * character with a real skinned mesh instead of blobby's original capsule-simple one. */
  facingTau: 0.12,
  /** How far a held pointer must sit from the view's vertical centre line before it
   * steers, in -1..1 view units. blobby's own threshold, unchanged: without it a hold
   * that only means "walk forward" also creeps the camera round, because a pointer is
   * never exactly on the centre line. */
  pointerTurnDeadZone: 0.1,
  /** Forward component every held pointer carries, in -1..1 view units. blobby's own
   * `mouse.y + 0.4`, unchanged, and the reason a plain hold walks instead of standing:
   * the pointer says which way to lean, the hold itself says go. */
  pointerForwardBias: 0.4,
  /** Movement magnitude (0..1) at or below which the blob stands still and plays 'idle'.
   * blobby compared its axes to exactly 0, which an analog stick resting fractionally off
   * centre never reaches. */
  moveEpsilon: 0.05,
  /** Movement magnitude above which a *held pointer* runs without Shift. blobby ran
   * whenever either axis passed 0.5 while the mouse was down, which — since every hold
   * already carries the 0.4 forward bias — meant a barely-upward drag was already a run
   * and the walk band was almost unreachable. Set past the bias so a hold near the centre
   * walks and only a deliberate reach out to the edge runs. Pointer-only, like blobby's
   * own rule: on keys and on a stick Shift runs, as it does for every other body here. */
  runMagnitude: 0.75,
} as const;

/**
 * Getting in and out of a vehicle: the timings behind `vehicleEntry.ts`.
 *
 * The three durations are the lengths of the Sketchbook animations this sequence was
 * ported from, kept because they are what the motion was tuned against — long enough to
 * read as a body moving, short enough that a player who just wants to drive is not
 * waiting on a cutscene. The spring values are Sketchbook's own for the same transitions.
 */
export const VEHICLE_ACCESS = {
  /** Reaching the door and swinging it open. */
  openDoorSeconds: 1,
  /** How much of that is the reach, before the leaf actually starts to move. */
  doorReachSeconds: 0.3,
  /** Lowering into the seat. */
  sitDownSeconds: 1.1,
  /** Rising back out of it. */
  standUpSeconds: 1,
  /** Pushing the door shut from outside. */
  closeDoorSeconds: 0.8,
  /** How far outboard of the body's flank the entry point stands, in metres. */
  doorStandOffset: 0.55,
  /** Ground speed, m/s, above which stepping out counts as a stumble rather than a step. */
  stumbleSpeed: 1,
  springFps: 60,
  springMass: 10,
  springDamping: 0.5,
} as const;
