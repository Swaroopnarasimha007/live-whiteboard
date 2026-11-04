import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { SessionController } from '../session/controller';

export function HoldToTalk({ session }: { session: SessionController }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const pressed = useRef(false);
  const release = () => {
    if (!pressed.current) return;
    pressed.current = false;
    void session.releaseHold();
  };
  const cancel = () => {
    if (!pressed.current) return;
    pressed.current = false;
    session.cancelHold();
  };
  useEffect(() => {
    if (state.capture === 'finishing' || state.capture === 'error') pressed.current = false;
  }, [state.capture]);
  useEffect(() => {
    const cancelOnBlur = () => {
      if (pressed.current) {
        pressed.current = false;
        session.cancelHold();
      }
    };
    const hidden = () => {
      if (document.hidden) cancelOnBlur();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelOnBlur();
    };
    window.addEventListener('blur', cancelOnBlur);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('blur', cancelOnBlur);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('keydown', key);
      cancelOnBlur();
    };
  }, [session]);
  const begin = () => {
    if (pressed.current || state.capture === 'finishing') return;
    pressed.current = true;
    void session.beginHold();
  };
  return (
    <button
      className="primary hold-to-talk"
      aria-label="Hold to talk"
      aria-pressed={state.holdActive}
      disabled={state.capture === 'finishing'}
      title="Hold to record; release to draw. Escape cancels unsent audio."
      style={{ touchAction: 'none', userSelect: 'none' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        begin();
      }}
      onPointerUp={release}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (!event.repeat) begin();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          release();
        }
      }}
      onBlur={cancel}
    >
      {state.capture === 'finishing'
        ? 'Finishing…'
        : state.holdActive
          ? `Listening · ${(state.holdElapsedMs / 1000).toFixed(1)}s`
          : 'Hold to talk'}
    </button>
  );
}
