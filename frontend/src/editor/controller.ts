import {
  colorSchema,
  shapeSchema,
  type ApplyResult,
  type Color,
  type Node,
  type Point,
  type Shape,
} from '../contracts';
import type { SceneStore } from '../scene';
import type { ViewportController } from '../board/viewport';
import type { NodePreview } from '../board/types';
import { getWorldBounds, worldToSection } from '../layout';

export type EditorTool = 'select' | 'hand' | Shape | 'arrow' | 'line';
export interface LabelEdit {
  id: string;
  kind: 'node' | 'edge';
  text: string;
  revision: number;
  multiline: boolean;
}
export interface EditorGesture {
  kind: 'move' | 'resize';
  originals: Readonly<Record<string, Node>>;
  primaryId: string;
  pointerLocal: Point | null;
}
export interface EditorSnapshot {
  tool: EditorTool;
  color: Color;
  snap: boolean;
  selectedIds: readonly string[];
  activeSectionId: string | null;
  connectorFrom: string | null;
  pointer: Point | null;
  previews: Readonly<Record<string, NodePreview>>;
  gesture: EditorGesture | null;
  labelEdit: LabelEdit | null;
  interactionInProgress: boolean;
  canUndo: boolean;
  canRedo: boolean;
  message: string;
}
export interface EditorOptions {
  uuid?: () => string;
  snapSize?: number;
}
export const SHAPE_LABELS: Record<Shape, string> = {
  rect: 'Rectangle',
  roundRect: 'Rounded rectangle',
  circle: 'Circle',
  ellipse: 'Ellipse',
  diamond: 'Decision',
  text: '',
};
const geometry = (n: Node): NodePreview => ({ x: n.x, y: n.y, width: n.width, height: n.height });
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function createEditorController(
  store: SceneStore,
  viewport: ViewportController,
  options: EditorOptions = {},
) {
  const snapSize = options.snapSize ?? 32;
  if (!Number.isFinite(snapSize) || snapSize < 1) throw new Error('Invalid snap interval');
  const initialActive =
    Object.values(store.getSnapshot().sections).sort((a, b) => a.order - b.order)[0]?.id ?? null;
  const initialHistory = store.getHistoryState();
  let state: EditorSnapshot = frozen({
    tool: 'select',
    color: 'neutral',
    snap: false,
    selectedIds: [],
    activeSectionId: initialActive,
    connectorFrom: null,
    pointer: null,
    previews: {},
    gesture: null,
    labelEdit: null,
    interactionInProgress: false,
    canUndo: initialHistory.undoCount > 0,
    canRedo: initialHistory.redoCount > 0,
    message: '',
  });
  let transaction = 0;
  let disposed = false;
  let committing = false;
  let protectionQueued = false;
  let replacementVersion = store.getReplacementVersion();
  const listeners = new Set<() => void>();
  const newId = () => `m_${(options.uuid ?? (() => crypto.randomUUID()))()}`;
  const protection = () =>
    state.gesture
      ? Object.keys(state.gesture.originals)
      : state.labelEdit
        ? [state.labelEdit.id]
        : [];
  const protect = () => {
    store.setEditingIds(protection());
    if (!protectionQueued) {
      protectionQueued = true;
      queueMicrotask(() => {
        protectionQueued = false;
        store.setEditingIds(disposed ? [] : protection());
      });
    }
  };
  const publish = (patch: Partial<EditorSnapshot>) => {
    if (disposed) return;
    const next = { ...state, ...patch };
    const history = store.getHistoryState();
    next.interactionInProgress = !!(next.gesture || next.labelEdit);
    next.canUndo = history.undoCount > 0;
    next.canRedo = history.redoCount > 0;
    state = frozen(next);
    protect();
    for (const listener of listeners) listener();
  };
  const fail = (message: string): ApplyResult => {
    publish({ message });
    return { status: 'rejected', code: 'VALIDATION', message };
  };
  const report = (result: ApplyResult) => {
    publish({
      message:
        result.status === 'rejected'
          ? result.message
          : result.status === 'pending'
            ? result.reason
            : '',
    });
    return result;
  };
  const commands = (input: readonly unknown[]): ApplyResult => {
    if (disposed) return { status: 'rejected', code: 'DISPOSED', message: 'Editor is disposed' };
    committing = true;
    try {
      return report(
        store.dispatchTransaction(input, {
          source: 'manual',
          sessionEpoch: store.getSessionEpoch(),
          transactionId: `editor_${++transaction}`,
        }),
      );
    } finally {
      committing = false;
    }
  };
  const editableNodes = () =>
    state.selectedIds.flatMap((id) => {
      const n = store.getSnapshot().nodes[id];
      return n ? [n] : [];
    });
  const cancelInteraction = () =>
    publish({ gesture: null, labelEdit: null, previews: {}, connectorFrom: null, pointer: null });
  const select = (id: string, toggle = false) => {
    const scene = store.getSnapshot();
    const entity = scene.nodes[id] ?? scene.edges[id];
    if (!entity) return;
    if (state.gesture || state.labelEdit) cancelInteraction();
    const ids = toggle
      ? state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id]
      : state.selectedIds.includes(id)
        ? state.selectedIds
        : [id];
    publish({
      selectedIds: ids,
      activeSectionId: entity.sectionId,
      ...(ids.length === 1 ? { color: (scene.nodes[ids[0]!] ?? scene.edges[ids[0]!])!.color } : {}),
      message: '',
    });
  };
  const setTool = (tool: EditorTool) => {
    cancelInteraction();
    publish({ tool, message: '' });
  };
  const insert = (type: Shape, world: Point, sectionHint?: string | null): ApplyResult => {
    cancelInteraction();
    viewport.suspendFollow();
    const scene = store.getSnapshot();
    let sectionId = Object.values(scene.sections)
      .sort((a, b) => b.order - a.order)
      .find((s) => {
        const b = getWorldBounds(s.bounds, s);
        return (
          world.x >= b.x && world.x <= b.x + b.width && world.y >= b.y && world.y <= b.y + b.height
        );
      })?.id;
    sectionId ??=
      sectionHint && scene.sections[sectionHint]
        ? sectionHint
        : state.activeSectionId && scene.sections[state.activeSectionId]
          ? state.activeSectionId
          : undefined;
    const input: unknown[] = [];
    if (!Object.keys(scene.sections).length) {
      sectionId = newId();
      input.push({ op: 'section.add', id: sectionId, title: 'Manual section' });
    }
    if (!sectionId) return fail('Choose a section before inserting outside existing sections');
    const origin = scene.sections[sectionId]?.origin ?? { x: 0, y: 0 };
    const local = worldToSection(world, { origin });
    const at: [number, number] = [local.x, local.y].map((v) =>
      state.snap ? Math.round(v / snapSize) * snapSize : v,
    ) as [number, number];
    const id = newId();
    input.push({
      op: 'node.add',
      id,
      section: sectionId,
      type,
      label: SHAPE_LABELS[type],
      color: state.color,
      at,
    });
    const result = commands(input);
    if (result.status === 'applied') {
      publish({ selectedIds: [id], activeSectionId: sectionId, tool: 'select' });
      if (type === 'text') editLabel(id);
    }
    return result;
  };
  const connect = (id: string): ApplyResult | undefined => {
    const scene = store.getSnapshot();
    const node = scene.nodes[id];
    if (!node) return;
    if (!state.connectorFrom) {
      viewport.suspendFollow();
      publish({
        connectorFrom: id,
        selectedIds: [id],
        activeSectionId: node.sectionId,
        pointer: {
          x: node.x + node.width / 2 + scene.sections[node.sectionId]!.origin.x,
          y: node.y + node.height / 2 + scene.sections[node.sectionId]!.origin.y,
        },
        message: '',
      });
      return;
    }
    const from = scene.nodes[state.connectorFrom];
    if (!from || from.id === id || from.sectionId !== node.sectionId)
      return fail('Choose a different node in the same section');
    const edgeId = newId();
    const result = commands([
      {
        op: 'edge.add',
        id: edgeId,
        section: node.sectionId,
        from: from.id,
        to: id,
        kind: state.tool === 'line' ? 'line' : 'arrow',
        color: state.color,
      },
    ]);
    if (result.status === 'applied')
      publish({ connectorFrom: null, pointer: null, tool: 'select', selectedIds: [edgeId] });
    return result;
  };
  const beginGesture = (kind: 'move' | 'resize', primaryId: string, world?: Point): boolean => {
    if (!store.getSnapshot().nodes[primaryId]) {
      fail('Select a node to move or resize');
      return false;
    }
    if (state.gesture?.kind === kind) return true;
    if (!state.selectedIds.includes(primaryId)) select(primaryId);
    const nodes = editableNodes();
    if (!nodes.length || nodes.some((n) => n.locked)) {
      fail('Unlock selected objects before moving or resizing');
      return false;
    }
    cancelInteraction();
    if (kind === 'resize') viewport.suspendFollow();
    const primary = nodes.find((n) => n.id === primaryId)!;
    const section = store.getSnapshot().sections[primary.sectionId]!;
    publish({
      gesture: {
        kind,
        originals: Object.fromEntries(nodes.map((n) => [n.id, n])),
        primaryId,
        pointerLocal: world ? worldToSection(world, section) : null,
      },
      message: '',
    });
    return true;
  };
  const previewMove = (world: Point) => {
    const gesture = state.gesture;
    if (!gesture || gesture.kind !== 'move' || !gesture.pointerLocal) return;
    const scene = store.getSnapshot();
    const primary = gesture.originals[gesture.primaryId]!;
    const section = scene.sections[primary.sectionId];
    if (!section) return;
    const pointer = worldToSection(world, section);
    viewport.suspendFollow();
    let dx = pointer.x - gesture.pointerLocal.x;
    let dy = pointer.y - gesture.pointerLocal.y;
    if (state.snap) {
      dx = Math.round((primary.x + dx) / snapSize) * snapSize - primary.x;
      dy = Math.round((primary.y + dy) / snapSize) * snapSize - primary.y;
    }
    const nodes = Object.values(gesture.originals);
    dx = clamp(
      dx,
      Math.max(...nodes.map((n) => -100_000 - n.x)),
      Math.min(...nodes.map((n) => 100_000 - n.x)),
    );
    dy = clamp(
      dy,
      Math.max(...nodes.map((n) => -100_000 - n.y)),
      Math.min(...nodes.map((n) => 100_000 - n.y)),
    );
    publish({
      previews: Object.fromEntries(
        nodes.map((n) => [n.id, { ...geometry(n), x: n.x + dx, y: n.y + dy }]),
      ),
    });
  };
  const previewResize = (previews: Readonly<Record<string, NodePreview>>): boolean => {
    const gesture = state.gesture;
    if (!gesture || gesture.kind !== 'resize') return false;
    const normalized: Record<string, NodePreview> = {};
    for (const [id, n] of Object.entries(gesture.originals)) {
      const p = previews[id];
      if (
        !p ||
        !Object.values(p).every(Number.isFinite) ||
        p.width < 24 ||
        p.height < 24 ||
        p.width > 2_000 ||
        p.height > 2_000 ||
        Math.abs(p.x) > 100_000 ||
        Math.abs(p.y) > 100_000
      )
        return false;
      if (n.type === 'circle' && Math.abs(p.width - p.height) > 0.01) return false;
      normalized[id] = { ...p, height: n.type === 'circle' ? p.width : p.height };
    }
    publish({ previews: normalized });
    return true;
  };
  const commitGesture = (): ApplyResult | undefined => {
    const gesture = state.gesture;
    if (!gesture) return;
    const scene = store.getSnapshot();
    if (
      Object.values(gesture.originals).some(
        (n) => scene.nodes[n.id]?.revision !== n.revision || scene.nodes[n.id]?.locked,
      )
    ) {
      cancelInteraction();
      return fail('An object changed during the gesture; no changes were committed');
    }
    const input: unknown[] = [];
    for (const [id, p] of Object.entries(state.previews)) {
      const old = gesture.originals[id]!;
      if (p.x === old.x && p.y === old.y && p.width === old.width && p.height === old.height)
        continue;
      input.push(
        gesture.kind === 'resize'
          ? { op: 'node.resize', id, width: p.width, height: p.height, at: [p.x, p.y] }
          : { op: 'node.update', id, set: { at: [p.x, p.y] } },
      );
    }
    store.setEditingIds([]);
    const result = input.length
      ? commands(input)
      : { status: 'duplicate' as const, revision: scene.revision };
    publish({ gesture: null, previews: {} });
    return result;
  };
  const editLabel = (id: string) => {
    const scene = store.getSnapshot();
    const n = scene.nodes[id];
    const e = scene.edges[id];
    const entity = n ?? e;
    if (!entity) return;
    if (entity.locked) {
      fail('Unlock the object before editing its label');
      return;
    }
    cancelInteraction();
    viewport.suspendFollow();
    select(id);
    publish({
      labelEdit: {
        id,
        kind: n ? 'node' : 'edge',
        text: entity.label,
        revision: entity.revision,
        multiline: n?.type === 'text' || entity.label.includes('\n'),
      },
      message: '',
    });
  };
  const commitLabel = (): ApplyResult | undefined => {
    const edit = state.labelEdit;
    if (!edit) return;
    const entity = store.getSnapshot().nodes[edit.id] ?? store.getSnapshot().edges[edit.id];
    if (!entity || entity.revision !== edit.revision || entity.locked) {
      cancelInteraction();
      return fail('The object changed while its label was being edited');
    }
    if (edit.kind === 'node' && entity.source === 'generated' && !edit.text.trim())
      return fail('Generated objects require a nonempty label');
    store.setEditingIds([]);
    const result = commands([
      {
        op: edit.kind === 'node' ? 'node.update' : 'edge.update',
        id: edit.id,
        set: { label: edit.text },
      },
    ]);
    if (result.status !== 'rejected') publish({ labelEdit: null });
    else protect();
    return result;
  };
  const deleteSelection = (): ApplyResult | undefined => {
    cancelInteraction();
    const scene = store.getSnapshot();
    const ids = new Set(state.selectedIds);
    const selected = state.selectedIds
      .map((id) => scene.nodes[id] ?? scene.edges[id])
      .filter((e) => !!e);
    if (!selected.length) return;
    if (selected.some((e) => e.locked)) return fail('Unlock selected objects before deleting');
    const input = selected
      .filter((e) => !('from' in e) || (!ids.has(e.from) && !ids.has(e.to)))
      .map((e) => ({ op: 'entity.delete', id: e.id }));
    const result = commands(input);
    if (result.status === 'applied') publish({ selectedIds: [] });
    return result;
  };
  const duplicate = (): ApplyResult | undefined => {
    cancelInteraction();
    const scene = store.getSnapshot();
    const nodes = editableNodes();
    if (!nodes.length)
      return fail('Select nodes to duplicate; internal connections are copied with them');
    const remap = new Map(nodes.map((n) => [n.id, newId()]));
    const input: unknown[] = [];
    for (const n of nodes) {
      const id = remap.get(n.id)!;
      input.push({
        op: 'node.add',
        id,
        section: n.sectionId,
        type: n.type,
        label: n.label,
        color: n.color,
        at: [n.x + 32, n.y + 32],
      });
      if (n.sizing === 'fixed')
        input.push({ op: 'node.resize', id, width: n.width, height: n.height });
    }
    for (const e of Object.values(scene.edges))
      if (remap.has(e.from) && remap.has(e.to))
        input.push({
          op: 'edge.add',
          id: newId(),
          section: e.sectionId,
          from: remap.get(e.from),
          to: remap.get(e.to),
          label: e.label,
          color: e.color,
          kind: e.kind,
        });
    const result = commands(input);
    if (result.status === 'applied') publish({ selectedIds: [...remap.values()] });
    return result;
  };
  const setSize = (id: string, width: number, height: number): ApplyResult => {
    cancelInteraction();
    const n = store.getSnapshot().nodes[id];
    if (!n) return fail('Select a node to resize');
    return commands([
      { op: 'node.resize', id, width, height: n.type === 'circle' ? width : height },
    ]);
  };
  const unsubscribe = store.subscribe((scene) => {
    const replaced = store.getReplacementVersion() !== replacementVersion;
    replacementVersion = store.getReplacementVersion();
    const exists = (id: string) => !!(scene.nodes[id] ?? scene.edges[id]);
    const conflict =
      !committing &&
      ((state.gesture &&
        Object.values(state.gesture.originals).some(
          (n) => scene.nodes[n.id]?.revision !== n.revision,
        )) ||
        (state.labelEdit &&
          (scene.nodes[state.labelEdit.id] ?? scene.edges[state.labelEdit.id])?.revision !==
            state.labelEdit.revision));
    const active =
      state.activeSectionId && scene.sections[state.activeSectionId]
        ? state.activeSectionId
        : (Object.values(scene.sections).sort((a, b) => a.order - b.order)[0]?.id ?? null);
    publish({
      selectedIds: state.selectedIds.filter(exists),
      activeSectionId: active,
      ...(state.connectorFrom && !scene.nodes[state.connectorFrom]
        ? { connectorFrom: null, pointer: null }
        : {}),
      ...(conflict
        ? {
            gesture: null,
            labelEdit: null,
            previews: {},
            message: 'An edited object changed; the interaction was cancelled',
          }
        : {}),
      ...(replaced
        ? {
            selectedIds: [],
            gesture: null,
            labelEdit: null,
            previews: {},
            connectorFrom: null,
            pointer: null,
            message: '',
          }
        : {}),
    });
  });
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getStore: () => store,
    setTool,
    insert,
    select,
    connect,
    beginMove: (id: string, world: Point) => beginGesture('move', id, world),
    beginResize: (id: string) => beginGesture('resize', id),
    previewMove,
    previewResize,
    commitGesture,
    editLabel,
    commitLabel,
    setLabelDraft: (text: string) => {
      if (state.labelEdit)
        publish({
          labelEdit: {
            ...state.labelEdit,
            text,
            multiline: state.labelEdit.multiline || text.includes('\n'),
          },
        });
    },
    cancelInteraction,
    escape: () => {
      cancelInteraction();
      publish({ tool: 'select', message: '' });
    },
    clearSelection: () => {
      cancelInteraction();
      publish({ selectedIds: [], message: '' });
    },
    setActiveSection: (id: string) => {
      if (store.getSnapshot().sections[id]) publish({ activeSectionId: id });
    },
    setSnap: (snap: boolean) => publish({ snap }),
    setColor: (color: Color): ApplyResult | undefined => {
      colorSchema.parse(color);
      publish({ color });
      if (!state.selectedIds.length) return;
      cancelInteraction();
      const scene = store.getSnapshot();
      return commands(
        state.selectedIds.map((id) => ({
          op: scene.nodes[id] ? 'node.update' : 'edge.update',
          id,
          set: { color },
        })),
      );
    },
    lockSelection: (locked: boolean) => {
      cancelInteraction();
      return state.selectedIds.length
        ? commands(state.selectedIds.map((id) => ({ op: 'entity.lock', id, locked })))
        : undefined;
    },
    renameSection: (id: string, title: string) => commands([{ op: 'section.rename', id, title }]),
    deleteSelection,
    duplicate,
    setSize,
    nudge: (delta: Point) => {
      const n = editableNodes()[0];
      if (!n) return;
      const origin = store.getSnapshot().sections[n.sectionId]!.origin;
      const start = { x: n.x + origin.x, y: n.y + origin.y };
      const amount = state.snap ? { x: delta.x * snapSize, y: delta.y * snapSize } : delta;
      if (beginGesture('move', n.id, start)) {
        previewMove({ x: start.x + amount.x, y: start.y + amount.y });
        return commitGesture();
      }
    },
    updatePointer: (world: Point) => {
      if (state.connectorFrom) publish({ pointer: world });
    },
    pointerDown: (
      id: string | null,
      world: Point,
      sectionId: string | null,
      shift = false,
    ): boolean => {
      if (state.tool === 'hand') return false;
      const shape = shapeSchema.safeParse(state.tool);
      if (shape.success) {
        insert(shape.data, world, sectionId);
        return false;
      }
      if (state.tool === 'arrow' || state.tool === 'line') {
        if (id && store.getSnapshot().nodes[id]) connect(id);
        else publish({ connectorFrom: null, pointer: null });
        return false;
      }
      if (!id) {
        cancelInteraction();
        if (!shift) publish({ selectedIds: [] });
        return false;
      }
      select(id, shift);
      return (
        !!store.getSnapshot().nodes[id] &&
        state.selectedIds.includes(id) &&
        beginGesture('move', id, world)
      );
    },
    undo: () => {
      cancelInteraction();
      return report(store.undo());
    },
    redo: () => {
      cancelInteraction();
      return report(store.redo());
    },
    clearMessage: () => publish({ message: '' }),
    dispose: () => {
      if (disposed) return;
      cancelInteraction();
      disposed = true;
      unsubscribe();
      listeners.clear();
      store.setEditingIds([]);
    },
  };
}
export type EditorController = ReturnType<typeof createEditorController>;
