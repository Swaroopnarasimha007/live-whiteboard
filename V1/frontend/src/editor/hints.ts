import type { EditorTool } from './controller';
export const TOOL_HINTS: Record<EditorTool, string> = {
  select:
    'Click to select; Shift+click adds or removes objects. Drag to move. Enter edits a label.',
  hand: 'Drag to pan. Space or the middle button also pans without changing tools.',
  rect: 'Click anywhere, including on a shape, to place a rectangle. Insertion returns to Select.',
  roundRect: 'Click anywhere to place a rounded rectangle. Insertion returns to Select.',
  circle: 'Click anywhere to place a circle. Insertion returns to Select.',
  ellipse: 'Click anywhere to place an ellipse. Insertion returns to Select.',
  diamond: 'Click anywhere to place a diamond. Insertion returns to Select.',
  text: 'Click anywhere to add text. Ctrl/Cmd+Enter saves; Escape cancels the label edit.',
  arrow:
    'Click a source node, then a different destination in the same section. Escape or blank canvas cancels.',
  line: 'Click two different nodes in the same section. Escape or blank canvas cancels.',
};
