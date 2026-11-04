import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type Konva from 'konva';
import { Layer, Line, Rect, Shape, Stage } from 'react-konva';
import type { Scene } from '../contracts';
import { createEdgeRouter, getWorldBounds } from '../layout';
import { bindNavigation } from './navigation';
import { EdgeView, NodeView, SectionView } from './views';
import { gridLines, visibleScene } from './visibility';
import { BOARD_THEME } from './theme';
import { CanvasMotionContext, type CanvasMotion } from './motion';
import { ColorModeContext, DARK_THEME } from '../styles/colorMode';
import type { BoardInteractions, BoardPointer, WhiteboardHandle, WhiteboardProps } from './types';
import './board.css';

const EMPTY_INTERACTIONS: BoardInteractions = {};
const EMPTY_IDS: readonly string[] = [];

function usePixelRatio() {
  const [ratio, setRatio] = useState(() =>
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
  );
  useEffect(() => {
    const media = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const update = () => setRatio(window.devicePixelRatio || 1);
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [ratio]);
  return ratio;
}

export const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(function Whiteboard(
  {
    scene,
    viewport,
    grid = false,
    cursor,
    tool = 'select',
    selectedIds = EMPTY_IDS,
    liveSectionId,
    previews,
    nativeTransformIds,
    interactions = EMPTY_INTERACTIONS,
    interactionOverlay,
    onStageReady,
    onDraw,
    ariaLabel = 'Whiteboard canvas',
  },
  ref,
) {
  const dark = useContext(ColorModeContext) === 'dark';
  const paint = dark
    ? {
        ...BOARD_THEME,
        background: DARK_THEME.canvas,
        grid: DARK_THEME.grid,
        selected: DARK_THEME.accent,
      }
    : BOARD_THEME;
  const element = useRef<HTMLDivElement>(null);
  const stage = useRef<Konva.Stage | null>(null);
  const sceneLayer = useRef<Konva.Layer | null>(null);
  const nodeRefs = useRef(new Map<string, Konva.Group>());
  const currentScene = useRef(scene);
  const stageCallback = useRef(onStageReady);
  const drawCallback = useRef(onDraw);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const [space, setSpace] = useState(false);
  const [motion] = useState<CanvasMotion>(() => ({ seen: new Set(), active: new Set() }));
  const ratio = usePixelRatio();
  const descriptionId = useId();
  const camera = useSyncExternalStore(
    viewport.subscribe,
    viewport.getSnapshot,
    viewport.getSnapshot,
  );
  const router = useMemo(() => createEdgeRouter(), []);
  useLayoutEffect(() => {
    currentScene.current = scene;
    stageCallback.current = onStageReady;
    drawCallback.current = onDraw;
    viewport.observeScene(scene, liveSectionId);
  }, [scene, viewport, liveSectionId, onStageReady, onDraw]);
  useLayoutEffect(() => {
    viewport.setSize(size);
  }, [viewport, size]);
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    return bindNavigation(host, viewport, {
      tool,
      onPanningChange: setPanning,
      onSpaceChange: setSpace,
      ...(interactions.onNavigationStart
        ? { onNavigationStart: interactions.onNavigationStart }
        : {}),
    });
  }, [viewport, tool, interactions.onNavigationStart]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => viewport.setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [viewport]);
  useLayoutEffect(() => {
    for (const layer of stage.current?.getLayers() ?? []) {
      layer.getCanvas().setPixelRatio(ratio);
      // Hit canvases use their own pixel ratio internally; leaving the default 1
      // avoids large buffers while Konva converts CSS pointer coordinates correctly.
      layer.batchDraw();
    }
  }, [ratio, size]);
  const stageRef = useCallback((value: Konva.Stage | null) => {
    stage.current = value;
    stageCallback.current?.(value);
  }, []);
  const layerRef = useCallback(
    (value: Konva.Layer | null) => {
      sceneLayer.current?.off('draw.board');
      sceneLayer.current = value;
      value?.on('draw.board', () => {
        const revision = currentScene.current.revision;
        if (element.current) {
          element.current.dataset.lastDrawnRevision = String(revision);
          element.current.dataset.drawCount = String(
            Number(element.current.dataset.drawCount ?? 0) + 1,
          );
        }
        drawCallback.current?.({
          revision,
          viewport: viewport.getViewport(),
          time: performance.now(),
        });
      });
    },
    [viewport],
  );
  useImperativeHandle(
    ref,
    () => ({ getStage: () => stage.current, getNodeRef: (id) => nodeRefs.current.get(id) }),
    [],
  );
  const onNodeRef = interactions.onNodeRef;
  const register = useCallback(
    (id: string, value: Konva.Group | null) => {
      if (value) nodeRefs.current.set(id, value);
      else nodeRefs.current.delete(id);
      onNodeRef?.(id, value);
    },
    [onNodeRef],
  );
  const pointer = useCallback(
    (event: Konva.KonvaEventObject<PointerEvent>, sectionId: string | null): BoardPointer => {
      const host = event.target.getStage()!.container().getBoundingClientRect();
      const screen = { x: event.evt.clientX - host.left, y: event.evt.clientY - host.top };
      const world = viewport.screenToWorld(screen);
      if (sectionId === null) {
        sectionId =
          Object.values(currentScene.current.sections)
            .sort((a, b) => b.order - a.order)
            .find((s) => {
              const b = getWorldBounds(s.bounds, s);
              return (
                world.x >= b.x &&
                world.x <= b.x + b.width &&
                world.y >= b.y &&
                world.y <= b.y + b.height
              );
            })?.id ?? null;
      }
      return { screen, world, nativeEvent: event.evt, sectionId };
    },
    [viewport],
  );
  const renderScene = useMemo((): Scene => {
    if (!previews || !Object.keys(previews).length) return scene;
    const nodes = { ...scene.nodes };
    for (const [id, preview] of Object.entries(previews)) {
      const node = nodes[id];
      if (
        node &&
        [preview.x, preview.y, preview.width, preview.height].every(Number.isFinite) &&
        Math.abs(preview.x) <= 100_000 &&
        Math.abs(preview.y) <= 100_000 &&
        preview.width >= 24 &&
        preview.width <= 2_000 &&
        preview.height >= 24 &&
        preview.height <= 2_000 &&
        (node.type !== 'circle' || preview.width === preview.height)
      )
        nodes[id] = { ...node, ...preview };
    }
    return { ...scene, nodes };
  }, [scene, previews]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const pinned = useMemo(
    () => new Set([...selectedIds, ...Object.keys(previews ?? {})]),
    [selectedIds, previews],
  );
  const visible = useMemo(
    () => visibleScene(renderScene, camera.viewport, size, router, 120, pinned),
    [renderScene, camera.viewport, size, router, pinned],
  );
  const lines = useMemo(
    () => (grid ? gridLines(camera.viewport, size) : null),
    [grid, camera.viewport, size],
  );
  const transform = {
    x: camera.viewport.x,
    y: camera.viewport.y,
    scaleX: camera.viewport.scale,
    scaleY: camera.viewport.scale,
  };
  return (
    <>
      <p id={descriptionId} className="board-sr-only">
        Scroll up to zoom in and down to zoom out at the pointer. Shift+scroll pans. Hold Space and
        drag, use the hand tool, or drag the middle mouse button to pan. Two fingers pan and pinch
        to zoom. Manual navigation pauses follow live. Use the scene outline for text descriptions.
      </p>
      <div
        ref={element}
        className="whiteboard-surface"
        role="application"
        aria-label={ariaLabel}
        aria-describedby={descriptionId}
        tabIndex={0}
        style={{
          cursor: panning ? 'grabbing' : tool === 'hand' || space ? 'grab' : (cursor ?? 'default'),
        }}
        data-scene-revision={scene.revision}
        data-viewport-x={camera.viewport.x}
        data-viewport-y={camera.viewport.y}
        data-viewport-scale={camera.viewport.scale}
        data-follow-live={camera.followLive}
        data-live-section={camera.liveSectionId ?? ''}
        data-visible-nodes={visible.nodes.length}
        data-visible-edges={visible.edges.length}
        data-pixel-ratio={ratio}
      >
        {size.width > 0 && size.height > 0 && (
          <Stage
            ref={stageRef}
            width={size.width}
            height={size.height}
            onPointerDown={(event) => {
              if (event.target === event.target.getStage())
                interactions.onCanvasPointerDown?.(pointer(event, null));
            }}
          >
            <Layer listening={false} name="background">
              <Rect width={size.width} height={size.height} fill={paint.background} />
              {lines && (
                <Shape
                  listening={false}
                  sceneFunc={(context) => {
                    context.beginPath();
                    context.strokeStyle = paint.grid;
                    context.lineWidth = 1;
                    for (const x of lines.xs) {
                      context.moveTo(Math.floor(x) + 0.5, 0);
                      context.lineTo(Math.floor(x) + 0.5, size.height);
                    }
                    for (const y of lines.ys) {
                      context.moveTo(0, Math.floor(y) + 0.5);
                      context.lineTo(size.width, Math.floor(y) + 0.5);
                    }
                    context.stroke();
                  }}
                />
              )}
            </Layer>
            <CanvasMotionContext.Provider value={motion}>
              <Layer ref={layerRef} {...transform} name="scene">
                {visible.sections.map((section) => (
                  <SectionView key={section.id} section={section} />
                ))}
                {visible.edges.map(({ edge, route }) => (
                  <EdgeView
                    key={edge.id}
                    edge={edge}
                    route={route}
                    interactions={interactions}
                    pointer={pointer}
                  />
                ))}
                {visible.nodes.map((node) => (
                  <NodeView
                    key={node.id}
                    node={nativeTransformIds?.includes(node.id) ? scene.nodes[node.id]! : node}
                    origin={renderScene.sections[node.sectionId]!.origin}
                    canDrag={tool === 'select' && !space && !panning}
                    interactions={interactions}
                    pointer={pointer}
                    register={register}
                  />
                ))}
              </Layer>
            </CanvasMotionContext.Provider>
            <Layer {...transform} name="interaction">
              {visible.edges
                .filter(({ edge }) => selected.has(edge.id))
                .map(({ edge, route }) => (
                  <Line
                    key={edge.id}
                    points={[...route.points]}
                    stroke={paint.selected}
                    strokeWidth={3}
                    dash={[6, 3]}
                    listening={false}
                  />
                ))}
              {visible.nodes
                .filter((node) => selected.has(node.id))
                .map((node) => {
                  const origin = renderScene.sections[node.sectionId]!.origin;
                  return (
                    <Rect
                      key={node.id}
                      x={origin.x + node.x - 4}
                      y={origin.y + node.y - 4}
                      width={node.width + 8}
                      height={node.height + 8}
                      stroke={paint.selected}
                      strokeWidth={2}
                      dash={[5, 3]}
                      listening={false}
                    />
                  );
                })}
              {interactionOverlay}
            </Layer>
          </Stage>
        )}
      </div>
    </>
  );
});
