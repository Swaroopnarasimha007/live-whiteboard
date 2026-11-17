import { createContext } from 'react';
import { THEME } from './tokens';

export type ColorMode = 'light' | 'dark';
export const ColorModeContext = createContext<ColorMode>('light');
export const DARK_THEME = Object.freeze({
  ...THEME,
  background: '#111113',
  surface: '#ffffff26',
  canvas: '#171719',
  section: '#ffffff26',
  text: '#f5f5f7',
  muted: '#b8b8bf',
  border: '#ffffff40',
  controlBorder: '#858b9b',
  accent: '#e4e4e7',
  accentSoft: '#ffffff33',
  danger: '#ffaca5',
  dangerSoft: '#482e32',
  grid: '#303033',
  disabled: '#979cab',
});
export const DARK_THEME_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(DARK_THEME).map(([key, value]) => [`--ui-${key}`, value])),
);
