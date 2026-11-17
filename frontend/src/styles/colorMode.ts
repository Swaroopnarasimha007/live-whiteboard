import { createContext } from 'react';
import { THEME } from './tokens';

export type ColorMode = 'light' | 'dark';
export const ColorModeContext = createContext<ColorMode>('light');
export const DARK_THEME = Object.freeze({
  ...THEME,
  background: '#15221e',
  surface: '#dbe5ce14',
  canvas: '#192923',
  section: '#dbe5ce14',
  text: '#f1f3e9',
  muted: '#c1ccbd',
  border: '#d5e3c636',
  controlBorder: '#a3b29b',
  accent: '#c4d8af',
  accentSoft: '#b7cba52b',
  danger: '#ffaca5',
  dangerSoft: '#482e32',
  grid: '#34473b',
  disabled: '#9ca995',
});
export const DARK_THEME_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(DARK_THEME).map(([key, value]) => [`--ui-${key}`, value])),
);
