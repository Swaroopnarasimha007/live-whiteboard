import type { Color } from '../contracts';
/** Single source for DOM variables, canvas paint and measured label typography. */
export const THEME = Object.freeze({
  font: 'Arial, sans-serif',
  background: '#f3f5fb',
  surface: '#ffffff',
  canvas: '#fcfcff',
  text: '#24304a',
  muted: '#58657c',
  border: '#dfe4ef',
  controlBorder: '#818187',
  accent: '#5b4bc4',
  accentSoft: '#efedff',
  danger: '#b42318',
  dangerSoft: '#fff0ee',
  grid: '#e2e6f1',
  section: '#f2f4fcbb',
  disabled: '#5c6878',
});
export const THEME_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(THEME).map(([key, value]) => [`--ui-${key}`, value])),
);
export const SHAPE_COLORS: Readonly<Record<Color, { fill: string; stroke: string }>> =
  Object.freeze({
    neutral: { fill: '#f1f5f9', stroke: '#64748b' },
    blue: { fill: '#eaf2ff', stroke: '#2563eb' },
    green: { fill: '#e9f7ef', stroke: '#15803d' },
    orange: { fill: '#fff3e3', stroke: '#c25b0b' },
    red: { fill: '#fdecec', stroke: '#c62828' },
    purple: { fill: '#f3edff', stroke: '#7e42b4' },
  });
