import { THEME } from '../styles/tokens';
export { SHAPE_COLORS } from '../styles/tokens';

/** Shared renderer tokens; Agent 7 may replace these through the integration owner. */
export const BOARD_THEME = Object.freeze({
  background: THEME.canvas,
  section: THEME.section,
  border: THEME.border,
  text: THEME.text,
  grid: THEME.grid,
  selected: THEME.accent,
});
