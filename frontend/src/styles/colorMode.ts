import { createContext } from 'react';
import { THEME } from './tokens';

export type ColorMode = 'light' | 'dark';
export const ColorModeContext = createContext<ColorMode>('light');
export const DARK_THEME = Object.freeze({
  ...THEME,
  background: '#4e21ba',
  surface: '#ffffff26',
  canvas: '#151d2b',
  section: '#ffffff26',
  text: '#ecf0fa',
  muted: '#adb9cd',
  border: '#ffffff40',
  controlBorder: '#858b9b',
  accent: '#20b2aa',
  accentSoft: '#ffffff33',
  danger: '#ffaca5',
  dangerSoft: '#482e32',
  grid: '#29354a',
  disabled: '#979cab',
});
export const DARK_THEME_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(DARK_THEME).map(([key, value]) => [`--ui-${key}`, value])),
);
