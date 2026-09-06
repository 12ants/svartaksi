import { useEffect, useRef } from 'react';

interface TouchJoystickProps {
  label: string;
  onChange: (value: { x: number; y: number }) => void;
  radius?: number;
  deadzone?: number;
  className?: string;
}

export function TouchJoystick({
  label,
  onChange,
  radius = 52,
  deadzone = 7,
  className = '',
}: TouchJoystickProps) {
  const pointerRef = useRef<number | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const release = () => {
    if (pointerRef.current === null) return;
    pointerRef.current = null;
    onChangeRef.current({ x: 0, y: 0 });
  };

  useEffect(() => release, []);

  return (
    <div
      className={`touch-joystick ${className}`.trim()}
      role="slider"
      aria-label={label}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={0}
      tabIndex={0}
      onPointerDown={(event) => {
        if (pointerRef.current !== null) return;
        pointerRef.current = event.pointerId;
        originRef.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (pointerRef.current !== event.pointerId) return;
        const dx = event.clientX - originRef.current.x;
        const dy = event.clientY - originRef.current.y;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude <= deadzone || magnitude === 0) {
          onChangeRef.current({ x: 0, y: 0 });
          return;
        }
        const scale = Math.min(1, magnitude / radius);
        onChangeRef.current({
          x: (dx / magnitude) * scale,
          y: (dy / magnitude) * scale,
        });
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <span aria-hidden="true" />
    </div>
  );
}
