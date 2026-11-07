export {
  createEditorController,
  SHAPE_LABELS,
  type EditorController,
  type EditorSnapshot,
  type EditorGesture,
  type EditorOptions,
  type EditorTool,
  type LabelEdit,
} from './controller';
export { EditorSurface, PALETTE_MIME, type EditorSurfaceProps } from './EditorSurface';
export { ToolPalette, SelectionProperties } from './controls';
export { TOOL_HINTS } from './hints';
export { handleEditorKeyDown, type EditorKeyEvent } from './shortcuts';
