import { expect, it } from 'vitest';
import { THEME, SHAPE_COLORS } from './tokens';
import { BOARD_THEME } from '../board/theme';
import { FONT_FAMILY } from '../layout/constants';
function luminance(hex: string) {
  const channels = hex
    .match(/[a-f\d]{2}/gi)!
    .map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}
it('keeps normal text, muted text and primary controls above 4.5:1 in the light theme', () => {
  for (const background of [
    THEME.surface,
    THEME.background,
    THEME.canvas,
    THEME.accentSoft,
    ...Object.values(SHAPE_COLORS).map((c) => c.fill),
  ])
    expect(contrast(THEME.text, background)).toBeGreaterThanOrEqual(4.5);
  for (const background of [THEME.surface, THEME.background])
    expect(contrast(THEME.muted, background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(THEME.surface, THEME.accent)).toBeGreaterThanOrEqual(4.5);
});
it('keeps focus/control boundaries at 3:1 and canvas typography/paint shared with DOM tokens', () => {
  expect(contrast(THEME.controlBorder, THEME.surface)).toBeGreaterThanOrEqual(3);
  expect(contrast(THEME.accent, THEME.surface)).toBeGreaterThanOrEqual(3);
  expect(BOARD_THEME.text).toBe(THEME.text);
  expect(BOARD_THEME.selected).toBe(THEME.accent);
  expect(FONT_FAMILY).toBe(THEME.font);
});
