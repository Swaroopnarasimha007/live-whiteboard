import { isTextTarget } from '../board/navigation';
import type { EditorController, EditorTool } from './controller';

export type EditorKeyEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'altKey'
  | 'isComposing'
  | 'target'
  | 'preventDefault'
>;
export function handleEditorKeyDown(event: EditorKeyEvent, editor: EditorController): boolean {
  if (isTextTarget(event.target) || event.isComposing) return false;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  let action: (() => unknown) | undefined;
  if (key === 'escape') action = editor.escape;
  else if (mod && key === 'z') action = event.shiftKey ? editor.redo : editor.undo;
  else if (mod && key === 'y') action = editor.redo;
  else if (mod && key === 'd') action = editor.duplicate;
  else if (!mod && !event.altKey && ['delete', 'backspace'].includes(key))
    action = editor.deleteSelection;
  else if (!mod && !event.altKey && key === 'enter' && editor.getSnapshot().selectedIds[0])
    action = () => editor.editLabel(editor.getSnapshot().selectedIds[0]!);
  else if (
    !mod &&
    !event.altKey &&
    ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) &&
    editor.getSnapshot().selectedIds.length
  ) {
    const distance = event.shiftKey ? 10 : 1;
    action = () =>
      editor.nudge({
        x: key === 'arrowleft' ? -distance : key === 'arrowright' ? distance : 0,
        y: key === 'arrowup' ? -distance : key === 'arrowdown' ? distance : 0,
      });
  } else if (!mod && !event.altKey) {
    const tools: Record<string, EditorTool> = {
      v: 'select',
      h: 'hand',
      r: event.shiftKey ? 'roundRect' : 'rect',
      c: 'circle',
      o: 'ellipse',
      d: 'diamond',
      t: 'text',
      a: 'arrow',
      l: 'line',
    };
    if (tools[key]) action = () => editor.setTool(tools[key]!);
  }
  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}
