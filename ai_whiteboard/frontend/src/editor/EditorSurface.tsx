import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import Konva from 'konva';
import { Arrow, Line, Transformer } from 'react-konva';
import {
  Whiteboard,
  type BoardInteractions,
  type BoardPointer,
  type WhiteboardHandle,
} from '../board';
import type { ViewportController } from '../board/viewport';
import type { NodePreview } from '../board/types';
import { FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, routeEdge, worldToScreen } from '../layout';
import type { SceneStore } from '../scene';
import type { EditorController, EditorTool } from './controller';
import './editor.css';
import { BOARD_THEME } from '../board/theme';

export interface EditorSurfaceProps {
  editor: EditorController;
  store: SceneStore;
  viewport: ViewportController;
  grid?: boolean;
  ariaLabel?: string;
  onStageReady?: (stage: Konva.Stage | null) => void;
}
export const PALETTE_MIME = 'application/x-live-whiteboard-shape';
const SHAPES = new Set<EditorTool>(['rect', 'roundRect', 'circle', 'ellipse', 'diamond', 'text']);

export const EditorSurface = forwardRef<WhiteboardHandle, EditorSurfaceProps>(
  function EditorSurface(
    { editor, store, viewport, grid = false, ariaLabel = 'Whiteboard canvas', onStageReady },
    ref,
  ) {
    const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
    const scene = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const camera = useSyncExternalStore(
      viewport.subscribe,
      viewport.getSnapshot,
      viewport.getSnapshot,
    );
    const board = useRef<WhiteboardHandle>(null);
    const surface = useRef<HTMLDivElement>(null);
    const transformer = useRef<Konva.Transformer>(null);
    const drag = useRef<{
      id: number;
      startX: number;
      startY: number;
      started: boolean;
      target: HTMLElement | null;
    } | null>(null);
    const nativeIds = useRef<readonly string[]>([]);
    const suppressDoubleClickUntil = useRef(0);
    const release = useCallback(() => {
      const current = drag.current;
      drag.current = null;
      if (current?.target) {
        try {
          if (current.target.hasPointerCapture(current.id))
            current.target.releasePointerCapture(current.id);
        } catch {
          /* Pointer may already have ended. */
        }
      }
    }, []);
    const resetNative = useCallback(() => {
      for (const id of nativeIds.current) {
        const n = store.getSnapshot().nodes[id];
        const group = board.current?.getNodeRef(id);
        if (n && group) {
          const origin = store.getSnapshot().sections[n.sectionId]!.origin;
          group.scale({ x: 1, y: 1 });
          group.position({ x: n.x + origin.x, y: n.y + origin.y });
        }
      }
      nativeIds.current = [];
      transformer.current?.forceUpdate();
    }, [store]);
    const cancel = useCallback(() => {
      release();
      editor.cancelInteraction();
      transformer.current?.stopTransform();
      resetNative();
    }, [editor, release, resetNative]);
    useImperativeHandle(
      ref,
      () => ({
        getStage: () => board.current?.getStage() ?? null,
        getNodeRef: (id) => board.current?.getNodeRef(id),
      }),
      [],
    );
    const pointerDown = useCallback(
      (id: string | null, event: BoardPointer) => {
        if (event.nativeEvent.button !== 0) return;
        if (editor.pointerDown(id, event.world, event.sectionId, event.nativeEvent.shiftKey)) {
          const target =
            event.nativeEvent.target instanceof HTMLElement ? event.nativeEvent.target : null;
          drag.current = {
            id: event.nativeEvent.pointerId,
            startX: event.screen.x,
            startY: event.screen.y,
            started: false,
            target,
          };
          try {
            target?.setPointerCapture(event.nativeEvent.pointerId);
          } catch {
            /* Window listeners still finish the gesture. */
          }
        }
      },
      [editor],
    );
    const readResize = useCallback(() => {
      const gesture = editor.getSnapshot().gesture;
      if (gesture?.kind !== 'resize') return;
      const previews: Record<string, NodePreview> = {};
      for (const [id, original] of Object.entries(gesture.originals)) {
        const group = board.current?.getNodeRef(id);
        const section = store.getSnapshot().sections[original.sectionId];
        if (!group || !section) return;
        previews[id] = {
          x: group.x() - section.origin.x,
          y: group.y() - section.origin.y,
          width: original.width * group.scaleX(),
          height: original.height * group.scaleY(),
        };
      }
      editor.previewResize(previews);
    }, [editor, store]);
    const finishResize = useCallback(() => {
      if (editor.getSnapshot().gesture?.kind !== 'resize') return;
      readResize();
      // Reset native scaling before canonical sizes become the new child dimensions.
      for (const id of nativeIds.current) board.current?.getNodeRef(id)?.scale({ x: 1, y: 1 });
      editor.commitGesture();
      resetNative();
    }, [editor, readResize, resetNative]);
    const interactions = useMemo<BoardInteractions>(
      () => ({
        onNodePointerDown: (id, event) => pointerDown(id, event),
        onEdgePointerDown: (id, event) => pointerDown(id, event),
        onCanvasPointerDown: (event) => pointerDown(null, event),
        onNodeDoubleClick: (id) => {
          if (
            editor.getSnapshot().tool !== 'select' ||
            performance.now() < suppressDoubleClickUntil.current
          )
            return;
          release();
          editor.cancelInteraction();
          editor.editLabel(id);
        },
        onNodeTransformStart: (id) => {
          if (editor.beginResize(id))
            nativeIds.current = Object.keys(editor.getSnapshot().gesture!.originals);
        },
        onNodeTransform: readResize,
        onNodeTransformEnd: finishResize,
        onNavigationStart: cancel,
      }),
      [pointerDown, release, editor, readResize, finishResize, cancel],
    );
    useEffect(() => {
      const point = (event: PointerEvent) => {
        const rect = surface.current?.getBoundingClientRect();
        return rect
          ? viewport.screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top })
          : null;
      };
      const move = (event: PointerEvent) => {
        const p = point(event);
        if (!p) return;
        if (editor.getSnapshot().connectorFrom) editor.updatePointer(p);
        const current = drag.current;
        if (
          !current ||
          event.pointerId !== current.id ||
          editor.getSnapshot().gesture?.kind !== 'move'
        )
          return;
        const rect = surface.current!.getBoundingClientRect();
        if (
          !current.started &&
          Math.hypot(
            event.clientX - rect.left - current.startX,
            event.clientY - rect.top - current.startY,
          ) < 3
        )
          return;
        current.started = true;
        editor.previewMove(p);
        event.preventDefault();
      };
      const up = (event: PointerEvent) => {
        if (drag.current?.id !== event.pointerId) return;
        if (drag.current.started) suppressDoubleClickUntil.current = performance.now() + 350;
        release();
        editor.commitGesture();
      };
      const abort = () => {
        if (editor.getSnapshot().gesture || editor.getSnapshot().connectorFrom) cancel();
        else release();
      };
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true);
      window.addEventListener('blur', abort);
      return () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', abort, true);
        window.removeEventListener('blur', abort);
        release();
        editor.cancelInteraction();
        resetNative();
      };
    }, [editor, viewport, release, resetNative, cancel]);
    useLayoutEffect(() => {
      if (!state.gesture) {
        release();
        if (nativeIds.current.length) {
          transformer.current?.stopTransform();
          resetNative();
        }
      }
    }, [state.gesture, resetNative, release]);
    useLayoutEffect(() => {
      const gesture = state.gesture;
      if (gesture?.kind !== 'resize') return;
      let changed = false;
      for (const [id, original] of Object.entries(gesture.originals)) {
        const group = board.current?.getNodeRef(id);
        const section = scene.sections[original.sectionId];
        if (!group || !section) continue;
        const p = state.previews[id] ?? original;
        const x = p.x + section.origin.x;
        const y = p.y + section.origin.y;
        const sx = p.width / original.width;
        const sy = p.height / original.height;
        if (
          Math.abs(group.x() - x) +
            Math.abs(group.y() - y) +
            Math.abs(group.scaleX() - sx) +
            Math.abs(group.scaleY() - sy) >
          1e-7
        ) {
          group.position({ x, y });
          group.scale({ x: sx, y: sy });
          changed = true;
        }
      }
      if (changed) transformer.current?.forceUpdate();
    }, [state.gesture, state.previews, scene.sections]);
    const selectedNodes = state.selectedIds.flatMap((id) =>
      scene.nodes[id] ? [scene.nodes[id]!] : [],
    );
    const canTransform =
      state.tool === 'select' &&
      !state.labelEdit &&
      selectedNodes.length > 0 &&
      selectedNodes.every((n) => !n.locked) &&
      selectedNodes.length === state.selectedIds.length;
    useLayoutEffect(() => {
      const nodes = canTransform
        ? state.selectedIds.flatMap((id) => {
            const group = board.current?.getNodeRef(id);
            return group ? [group] : [];
          })
        : [];
      transformer.current?.nodes(nodes);
      transformer.current?.getLayer()?.batchDraw();
    }, [canTransform, state.selectedIds, scene.nodes]);
    let connection: number[] | null = null;
    if (state.connectorFrom && state.pointer) {
      const n = scene.nodes[state.connectorFrom];
      if (n) {
        const origin = scene.sections[n.sectionId]!.origin;
        connection = [
          n.x + n.width / 2 + origin.x,
          n.y + n.height / 2 + origin.y,
          state.pointer.x,
          state.pointer.y,
        ];
      }
    }
    const edit = state.labelEdit;
    let editBox: { x: number; y: number; width: number; height: number } | undefined;
    if (edit) {
      const n = scene.nodes[edit.id];
      const e = scene.edges[edit.id];
      if (n) {
        const origin = scene.sections[n.sectionId]!.origin;
        editBox = {
          x: n.x + origin.x,
          y: n.y + origin.y,
          width: Math.max(140, n.width),
          height: Math.max(56, n.height),
        };
      } else if (e) {
        const route = routeEdge(e, scene);
        if (route)
          editBox = route.label?.box ?? {
            x: (route.start.x + route.end.x) / 2 - 90,
            y: (route.start.y + route.end.y) / 2 - 30,
            width: 180,
            height: 60,
          };
      }
    }
    const screenEdit = editBox ? worldToScreen(editBox, camera.viewport) : null;
    return (
      <div
        ref={surface}
        className="editor-surface"
        data-editor-tool={state.tool}
        data-interaction-in-progress={state.interactionInProgress}
        data-selected-ids={state.selectedIds.join(',')}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(PALETTE_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          const type = event.dataTransfer.getData(PALETTE_MIME) as EditorTool;
          if (!SHAPES.has(type)) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          editor.insert(
            type as import('../contracts').Shape,
            viewport.screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
          );
        }}
      >
        <Whiteboard
          ref={board}
          scene={scene}
          viewport={viewport}
          grid={grid}
          ariaLabel={ariaLabel}
          cursor={
            SHAPES.has(state.tool) || state.tool === 'arrow' || state.tool === 'line'
              ? 'crosshair'
              : 'default'
          }
          tool={state.tool === 'hand' ? 'hand' : 'select'}
          selectedIds={state.selectedIds}
          previews={state.previews}
          nativeTransformIds={
            state.gesture?.kind === 'resize' ? Object.keys(state.gesture.originals) : []
          }
          interactions={interactions}
          {...(onStageReady ? { onStageReady } : {})}
          interactionOverlay={
            <>
              {connection &&
                (state.tool === 'arrow' ? (
                  <Arrow
                    points={connection}
                    stroke={BOARD_THEME.selected}
                    fill={BOARD_THEME.selected}
                    dash={[6, 4]}
                    strokeWidth={1.5}
                    listening={false}
                  />
                ) : (
                  <Line
                    points={connection}
                    stroke={BOARD_THEME.selected}
                    dash={[6, 4]}
                    strokeWidth={1.5}
                    listening={false}
                  />
                ))}
              <Transformer
                ref={transformer}
                name="editor-transformer"
                visible={canTransform}
                rotateEnabled={false}
                flipEnabled={false}
                ignoreStroke
                keepRatio={selectedNodes.some((n) => n.type === 'circle')}
                shiftBehavior="none"
                enabledAnchors={
                  selectedNodes.some((n) => n.type === 'circle')
                    ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
                    : [
                        'top-left',
                        'top-center',
                        'top-right',
                        'middle-left',
                        'middle-right',
                        'bottom-left',
                        'bottom-center',
                        'bottom-right',
                      ]
                }
                anchorSize={10}
                padding={0}
                boundBoxFunc={(oldBox, newBox) => {
                  if (
                    newBox.width <= 0 ||
                    newBox.height <= 0 ||
                    oldBox.width <= 0 ||
                    oldBox.height <= 0
                  )
                    return oldBox;
                  const rx = newBox.width / oldBox.width;
                  const ry = newBox.height / oldBox.height;
                  const valid = selectedNodes.every((n) => {
                    const group = board.current?.getNodeRef(n.id);
                    const width = n.width * (group?.scaleX() ?? 1) * rx;
                    const height = n.height * (group?.scaleY() ?? 1) * ry;
                    return width >= 24 && height >= 24 && width <= 2_000 && height <= 2_000;
                  });
                  return valid ? newBox : oldBox;
                }}
              />
            </>
          }
        />
        {edit && editBox && screenEdit && (
          <LabelOverlay
            key={edit.id}
            editor={editor}
            text={edit.text}
            multiline={edit.multiline}
            maxLength={edit.kind === 'node' ? 500 : 200}
            style={{
              left: screenEdit.x,
              top: screenEdit.y,
              width: editBox.width,
              transform: `scale(${camera.viewport.scale})`,
              transformOrigin: 'top left',
            }}
            height={editBox.height}
          />
        )}
      </div>
    );
  },
);

function LabelOverlay({
  editor,
  text,
  multiline,
  maxLength,
  style,
  height,
}: {
  editor: EditorController;
  text: string;
  multiline: boolean;
  maxLength: number;
  style: import('react').CSSProperties;
  height: number;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <div
      className="editor-label-overlay"
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        ref={input}
        aria-label="Edit object label"
        value={text}
        maxLength={maxLength}
        style={{
          height,
          fontFamily: FONT_FAMILY,
          fontSize: FONT_SIZE,
          lineHeight: `${LINE_HEIGHT}px`,
        }}
        onChange={(event) => editor.setLabelDraft(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            editor.cancelInteraction();
          } else if (
            event.key === 'Enter' &&
            ((!multiline && !event.shiftKey) || event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            event.stopPropagation();
            editor.commitLabel();
          }
        }}
      />
      <div>
        <button onClick={() => editor.commitLabel()}>Save label</button>
        <button onClick={() => editor.cancelInteraction()}>Cancel label</button>
      </div>
      <small>{multiline ? 'Ctrl/Cmd+Enter to save' : 'Enter to save'} · Escape to cancel</small>
    </div>
  );
}
