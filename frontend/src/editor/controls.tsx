import { useSyncExternalStore } from 'react';
import { colorSchema, type Shape } from '../contracts';
import { SHAPE_COLORS } from '../board/theme';
import { PALETTE_MIME } from './EditorSurface';
import type { EditorController } from './controller';

import { TOOL_HINTS } from './hints';
const PALETTE: { type: Shape | 'arrow' | 'line'; label: string }[] = [
  { type: 'rect', label: 'Rectangle' },
  { type: 'roundRect', label: 'Rounded rectangle' },
  { type: 'circle', label: 'Circle' },
  { type: 'ellipse', label: 'Ellipse' },
  { type: 'diamond', label: 'Diamond' },
  { type: 'text', label: 'Text' },
  { type: 'arrow', label: 'Arrow' },
  { type: 'line', label: 'Line' },
];
export function ToolPalette({ editor }: { editor: EditorController }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  return (
    <section aria-label="Shape palette">
      <h2>Add an object</h2>
      <div className="editor-palette">
        {PALETTE.map(({ type, label }) => (
          <button
            key={type}
            aria-label={`Add ${label.toLowerCase()}`}
            aria-pressed={state.tool === type}
            title={TOOL_HINTS[type]}
            onClick={() => editor.setTool(type)}
            draggable={type !== 'arrow' && type !== 'line'}
            onDragStart={(event) => {
              editor.setTool(type);
              event.dataTransfer.setData(PALETTE_MIME, type);
              event.dataTransfer.effectAllowed = 'copy';
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="editor-tool-hint" role="status" aria-label="Tool hint">
        {TOOL_HINTS[state.tool]}
      </p>
      <div className="editor-colors" aria-label="Object colors">
        {colorSchema.options.map((color) => (
          <button
            key={color}
            aria-label={`Color ${color}`}
            aria-pressed={state.color === color}
            title={`Apply ${color} to selection and new objects`}
            onClick={() => editor.setColor(color)}
          >
            <span
              style={{
                background: SHAPE_COLORS[color].fill,
                borderColor: SHAPE_COLORS[color].stroke,
              }}
            />
          </button>
        ))}
      </div>
    </section>
  );
}
export function SelectionProperties({ editor }: { editor: EditorController }) {
  const store = editor.getStore();
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const scene = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const entity =
    state.selectedIds.length === 1
      ? (scene.nodes[state.selectedIds[0]!] ?? scene.edges[state.selectedIds[0]!])
      : undefined;
  const nodes = state.selectedIds.flatMap((id) => (scene.nodes[id] ? [scene.nodes[id]!] : []));
  const allLocked =
    state.selectedIds.length > 0 &&
    state.selectedIds.every((id) => (scene.nodes[id] ?? scene.edges[id])?.locked);
  return (
    <section className="editor-properties" aria-label="Selection properties">
      <h2>Selection</h2>
      <output aria-label="Selected object">
        {entity
          ? entity.label || ('from' in entity ? 'Unlabelled connection' : 'Empty text')
          : state.selectedIds.length
            ? `${state.selectedIds.length} objects`
            : 'None'}
      </output>
      {entity && (
        <>
          <p className="full-label" aria-label="Full object label">
            {entity.label || '(empty)'}
          </p>
          <button disabled={entity.locked} onClick={() => editor.editLabel(entity.id)}>
            Edit label
          </button>
        </>
      )}
      {entity && 'width' in entity && (
        <form
          key={entity.id}
          className="editor-size-form"
          aria-label="Object size"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            editor.setSize(
              entity.id,
              Number(data.get('width')),
              entity.type === 'circle' ? Number(data.get('width')) : Number(data.get('height')),
            );
          }}
        >
          <label>
            {entity.type === 'circle' ? 'Diameter' : 'Width'}
            <input
              aria-label={entity.type === 'circle' ? 'Object diameter' : 'Object width'}
              name="width"
              type="number"
              min={24}
              max={2_000}
              step="any"
              defaultValue={entity.width}
              required
              disabled={entity.locked}
            />
          </label>
          {entity.type !== 'circle' && (
            <label>
              Height
              <input
                aria-label="Object height"
                name="height"
                type="number"
                min={24}
                max={2_000}
                step="any"
                defaultValue={entity.height}
                required
                disabled={entity.locked}
              />
            </label>
          )}
          <button disabled={entity.locked}>Apply size</button>
        </form>
      )}
      {state.selectedIds.length > 0 && (
        <div className="editor-property-actions">
          <button onClick={() => editor.lockSelection(!allLocked)}>
            {allLocked ? 'Unlock selection' : 'Lock selection'}
          </button>
          <button onClick={() => editor.duplicate()} disabled={!nodes.length}>
            Duplicate
          </button>
          <button
            onClick={() => editor.deleteSelection()}
            disabled={state.selectedIds.some((id) => (scene.nodes[id] ?? scene.edges[id])?.locked)}
          >
            Delete
          </button>
        </div>
      )}
      {state.message && (
        <p className="editor-message" role="alert">
          {state.message}
        </p>
      )}
    </section>
  );
}
