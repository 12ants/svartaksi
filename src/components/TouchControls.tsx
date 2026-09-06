import { useEffect, type PointerEventHandler, type ReactNode } from 'react';
import { CAMERA_LABELS } from '../svartaksi/cameraModes';
import type { CameraMode, PlayerMode } from '../svartaksi/svartaksiRuntime';
import type { BlobControlScheme, PlayerInputState } from '../svartaksi/playerInput';
import { TouchJoystick } from './TouchJoystick';
import './touch-controls.css';

interface TouchControlsProps {
  mode: PlayerMode;
  cameraMode: CameraMode;
  inspectorEnabled: boolean;
  onInput: (state: Partial<PlayerInputState>) => void;
  onRelease: () => void;
  onInteract: () => void;
  onToggleBlobForm: () => void;
  /** Which scheme the blob is currently driven by, and the request to swap it. Keyboard
   * has V for this; without a button the scheme was unreachable on a touch device, which
   * is the one place blobby's drag-to-move is the *only* way to move at all. */
  blobControlScheme: BlobControlScheme;
  onToggleBlobControlScheme: () => void;
  onCamera: () => void;
  onBus: () => void;
  onMenu: (trigger: HTMLElement) => void;
  onInspectHere: () => void;
}

function HoldButton({
  label,
  onChange,
  children,
}: {
  label: string;
  onChange: (pressed: boolean) => void;
  children: ReactNode;
}) {
  const press: PointerEventHandler<HTMLButtonElement> = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onChange(true);
  };
  const release = () => onChange(false);
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {children}
    </button>
  );
}

export function TouchControls({
  mode,
  cameraMode,
  inspectorEnabled,
  onInput,
  onRelease,
  onInteract,
  onToggleBlobForm,
  blobControlScheme,
  onToggleBlobControlScheme,
  onCamera,
  onBus,
  onMenu,
  onInspectHere,
}: TouchControlsProps) {
  useEffect(() => {
    document.addEventListener('visibilitychange', onRelease);
    window.addEventListener('blur', onRelease);
    return () => {
      document.removeEventListener('visibilitychange', onRelease);
      window.removeEventListener('blur', onRelease);
      onRelease();
    };
  }, [onRelease]);

  const freecam = cameraMode === 'freecam';

  return (
    <section className="touch-controls" aria-label="Touch controls">
      <TouchJoystick
        label="Movement joystick"
        onChange={({ x, y }) => onInput({
          forward: y === 0 ? 0 : -y,
          turn: x === 0 ? 0 : -x,
        })}
      />

      {freecam ? (
        <TouchJoystick
          label="Look joystick"
          className="touch-look"
          onChange={({ x, y }) => onInput({
            lookX: x === 0 ? 0 : -x,
            lookY: y === 0 ? 0 : -y,
          })}
        />
      ) : null}

      <div className="touch-actions">
        {freecam ? (
          <>
            <HoldButton label="Move up" onChange={(pressed) => onInput({ vertical: pressed ? 1 : 0 })}>UP</HoldButton>
            <HoldButton label="Move down" onChange={(pressed) => onInput({ vertical: pressed ? -1 : 0 })}>DOWN</HoldButton>
          </>
        ) : mode === 'bus' ? (
          <>
            <HoldButton label="Run" onChange={(pressed) => onInput({ boost: pressed })}>RUN</HoldButton>
            <button type="button" className="touch-primary" aria-label="Get off bus" onClick={onBus}>GET OFF</button>
          </>
        ) : mode === 'blob' ? (
          <>
            <HoldButton label="Run" onChange={(pressed) => onInput({ boost: pressed })}>RUN</HoldButton>
            <button
              type="button"
              aria-label={`Blob controls, currently ${blobControlScheme}`}
              onClick={onToggleBlobControlScheme}
            >
              {blobControlScheme === 'blobby' ? 'BLOBBY' : 'DIRECT'}
            </button>
            <button type="button" aria-label="Back to normal" onClick={onToggleBlobForm}>NORMAL</button>
          </>
        ) : mode === 'horse' ? (
          <>
            <HoldButton label="Canter" onChange={(pressed) => onInput({ boost: pressed })}>CANTER</HoldButton>
            <HoldButton label="Walk" onChange={(pressed) => onInput({ crouch: pressed })}>WALK</HoldButton>
            <button type="button" aria-label="Dismount horse" onClick={onInteract}>DISMOUNT</button>
          </>
        ) : (
          <>
            <HoldButton
              label={mode === 'foot' ? 'Run' : 'Boost'}
              onChange={(pressed) => onInput({ boost: pressed })}
            >
              {mode === 'foot' ? 'RUN' : 'BOOST'}
            </HoldButton>
            <HoldButton label="Brake" onChange={(pressed) => onInput({ brake: pressed })}>BRAKE</HoldButton>
            <button type="button" aria-label={mode === 'foot' ? 'Enter car / mount horse' : 'Get out of car'} onClick={onInteract}>
              {mode === 'foot' ? 'ENTER' : 'EXIT'}
            </button>
            {mode === 'foot' ? (
              <button type="button" aria-label="Become blob" onClick={onToggleBlobForm}>BLOB</button>
            ) : null}
          </>
        )}
        <button
          type="button"
          aria-label={`Change camera, currently ${CAMERA_LABELS[cameraMode]}`}
          onClick={onCamera}
        >
          <span>CAM</span>
          <span className="touch-camera-mode">{CAMERA_LABELS[cameraMode].slice(0, 4).trim().toUpperCase()}</span>
        </button>
        {!freecam && mode !== 'bus' ? <button type="button" aria-label="Open bus picker" onClick={onBus}>BUS</button> : null}
        {inspectorEnabled ? <button type="button" aria-label="Inspect here" onClick={onInspectHere}>INSPECT</button> : null}
        <button
          type="button"
          aria-label="Open menu"
          onClick={(event) => onMenu(event.currentTarget)}
        >
          MENU
        </button>
      </div>
    </section>
  );
}
