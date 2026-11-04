import { createContext } from 'react';
import { THEME } from './tokens';

export type ColorMode = 'light' | 'dark';
export const ColorModeContext = createContext<ColorMode>('light');
export const DARK_THEME = Object.freeze({
  ...THEME,
  background: '#26282e',
  surface: '#2d3038',
  canvas: '#26282e',
  section: '#30333be6',
  text: '#ececf2',
  muted: '#b9bdc9',
  border: '#454955',
  controlBorder: '#858b9b',
  accent: '#b6a8ff',
  accentSoft: '#30333b',
  danger: '#ffaca5',
  dangerSoft: '#482e32',
  grid: '#3b3e48',
  disabled: '#979cab',
});
export const DARK_THEME_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(DARK_THEME).map(([key, value]) => [`--ui-${key}`, value])),
);
