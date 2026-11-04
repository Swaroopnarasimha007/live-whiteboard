import { createContext } from 'react';
import { THEME } from './tokens';

export type ColorMode = 'light' | 'dark';
export const ColorModeContext = createContext<ColorMode>('light');
export const DARK_THEME = Object.freeze({
  ...THEME,
  background: '#111722',
  surface: '#1b2434',
  canvas: '#151d2b',
  section: '#202c40cc',
  text: '#ecf0fa',
  muted: '#adb9cd',
  border: '#35435a',
  controlBorder: '#858b9b',
  accent: '#b8adff',
  accentSoft: '#302d50',
  danger: '#ffaca5',
  dangerSoft: '#482e32',
  grid: '#29354a',
  disabled: '#979cab',
});
export const DARK_THEME_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(DARK_THEME).map(([key, value]) => [`--ui-${key}`, value])),
);
