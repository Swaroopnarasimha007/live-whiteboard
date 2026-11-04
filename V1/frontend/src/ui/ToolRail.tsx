import { useSyncExternalStore } from 'react';
import {
  MousePointer2,
  Hand,
  Square,
  RectangleHorizontal,
  Circle,
  Diamond,
  Type,
  ArrowUpRight,
  Minus,
  Undo2,
  Redo2,
  type LucideIcon,
} from 'lucide-react';
import { colorSchema, type Shape } from '../contracts';
import { PALETTE_MIME } from '../editor';
import { TOOL_HINTS } from '../editor/hints';
import type { RendererRuntime } from '../app/rendererRuntime';
import { SHAPE_COLORS } from '../styles/tokens';
const TOOLS: {
  type: Shape | 'select' | 'hand' | 'arrow' | 'line';
  label: string;
  icon: LucideIcon;
}[] = [
  { type: 'select', label: 'Select', icon: MousePointer2 },
  { type: 'hand', label: 'Hand', icon: Hand },
  { type: 'rect', label: 'Add rectangle', icon: Square },
  { type: 'roundRect', label: 'Add rounded rectangle', icon: RectangleHorizontal },
  { type: 'circle', label: 'Add circle', icon: Circle },
  { type: 'ellipse', label: 'Add ellipse', icon: Circle },
  { type: 'diamond', label: 'Add diamond', icon: Diamond },
  { type: 'text', label: 'Add text', icon: Type },
  { type: 'arrow', label: 'Add arrow', icon: ArrowUpRight },
  { type: 'line', label: 'Add line', icon: Minus },
];
export function ToolRail({ runtime }: { runtime: RendererRuntime }) {
  const editor = runtime.editor;
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  return (
    <aside className="tool-rail" aria-label="Drawing tools">
      <div className="rail-tools" role="group" aria-label="Shape palette">
        {TOOLS.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            aria-label={label}
            aria-pressed={state.tool === type}
            title={`${label}. ${TOOL_HINTS[type]} Keyboard: activate a shape to insert at the view centre; use Scene outline for connector endpoints.`}
            onClick={(event) => {
              editor.setTool(type);
              if (event.detail === 0 && !['select', 'hand', 'arrow', 'line'].includes(type)) {
                const b = runtime.viewport.getVisibleWorldBounds();
                editor.insert(type as Shape, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
              }
            }}
            draggable={!['select', 'hand', 'arrow', 'line'].includes(type)}
            onDragStart={(event) => {
              editor.setTool(type);
              event.dataTransfer.setData(PALETTE_MIME, type);
              event.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <Icon
              className={type === 'ellipse' ? 'ellipse-icon' : undefined}
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
      <div className="rail-colors" role="group" aria-label="Object colors">
        {colorSchema.options.map((color) => (
          <button
            key={color}
            aria-label={`Color ${color}`}
            aria-pressed={state.color === color}
            title={`Apply ${color} to selection and new objects`}
            onClick={() => editor.setColor(color)}
          >
            <span
              className="color-swatch"
              style={{
                background: SHAPE_COLORS[color].fill,
                borderColor: SHAPE_COLORS[color].stroke,
              }}
            />
          </button>
        ))}
      </div>
      <div className="rail-history" role="group" aria-label="History">
        <button
          aria-label="Undo"
          title="Undo (Ctrl/Cmd+Z)"
          disabled={!state.canUndo}
          onClick={() => editor.undo()}
        >
          <Undo2 size={18} aria-hidden="true" />
        </button>
        <button
          aria-label="Redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          disabled={!state.canRedo}
          onClick={() => editor.redo()}
        >
          <Redo2 size={18} aria-hidden="true" />
        </button>
      </div>
      <p className="sr-only" role="status" aria-label="Tool hint">
        {TOOL_HINTS[state.tool]}
      </p>
    </aside>
  );
}
