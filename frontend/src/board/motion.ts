import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import Konva from 'konva';

export interface CanvasMotion {
  seen: Set<string>;
  active: Set<Konva.Group>;
}

export const CanvasMotionContext = createContext<CanvasMotion | null>(null);

/** Presentation only: never animate geometry or delay scene operations/hit testing. */
export function useCanvasEntrance(id: string) {
  const group = useRef<Konva.Group | null>(null);
  const motion = useContext(CanvasMotionContext);
  useLayoutEffect(() => {
    const node = group.current;
    if (!node || !motion || motion.seen.has(id)) return;
    // Culling and undo must not make an existing object replay its entrance.
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Large imports stay responsive; all objects are interactive immediately.
    if (media.matches || motion.active.size >= 48) {
      motion.seen.add(id);
      return;
    }
    motion.active.add(node);
    node.opacity(0.18);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      media.removeEventListener('change', reduce);
      node.opacity(1);
      motion.active.delete(node);
      tween.destroy();
      node.getLayer()?.batchDraw();
    };
    const tween = new Konva.Tween({
      node,
      duration: 0.16,
      opacity: 1,
      easing: Konva.Easings.EaseOut,
      onFinish: finish,
    });
    const reduce = () => {
      if (media.matches) finish();
    };
    media.addEventListener('change', reduce);
    // Defer playback until the first frame, so StrictMode's rehearsal can clean
    // up without marking an object seen before it has actually been painted.
    const frame = requestAnimationFrame(() => {
      motion.seen.add(id);
      tween.play();
    });
    return () => {
      media.removeEventListener('change', reduce);
      finish();
    };
  }, [id, motion]);
  return group;
}
