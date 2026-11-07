import { describe, expect, it, vi } from 'vitest';
import { shapeSchema } from '../contracts';
import { FONT_CSS, LINE_HEIGHT } from './constants';
import {
  createCanvasTextMeasurer,
  estimatedTextMeasurer,
  fitText,
  layoutNodeText,
  measureNode,
  prepareLayoutFonts,
  wrapText,
} from './text';
import { fixedMeasurer } from './test-fixtures';

const options = { measurer: fixedMeasurer };
describe('shared typography and sizing', () => {
  it.each(shapeSchema.options)(
    'sizes %s with finite valid dimensions and fitting labels',
    (type) => {
      const result = measureNode({ type, label: 'Readable labels with multiple words' }, options);
      expect(result.width).toBeGreaterThanOrEqual(24);
      expect(result.width).toBeLessThanOrEqual(2_000);
      expect(result.height).toBeGreaterThanOrEqual(24);
      expect(result.height).toBeLessThanOrEqual(2_000);
      if (type === 'circle') expect(result.width).toBe(result.height);
      expect(result.text.truncated).toBe(false);
      expect(result.text.width).toBeLessThanOrEqual(result.text.availableWidth);
      expect(result.text.height).toBeLessThanOrEqual(result.text.availableHeight);
    },
  );
  it('wraps words, explicit newlines, blank paragraphs and long words deterministically', () => {
    expect(wrapText('one two three', 56, options)).toEqual(['one two', 'three']);
    expect(wrapText('a\r\n\r\nb', 80, options)).toEqual(['a', '', 'b']);
    expect(wrapText('abcdefghij', 24, options)).toEqual(['abc', 'def', 'ghi', 'j']);
    expect(wrapText('e\u0301e\u0301', 16, options)).toEqual(['e\u0301', 'e\u0301']);
  });
  it('preserves manual placeholders without NaN geometry', () => {
    for (const label of ['', ' ', '\n']) {
      const result = measureNode({ type: 'text', label }, options);
      expect(Number.isFinite(result.width + result.height)).toBe(true);
      expect(result.text.fullText).toBe(label);
    }
  });
  it('caps huge multiline labels and exposes full text with visible truncation', () => {
    const label = 'x\n'.repeat(249);
    const result = measureNode({ type: 'diamond', label }, options);
    expect(result.height).toBe(2_000);
    expect(result.text.truncated).toBe(true);
    expect(result.text.lines.at(-1)).toContain('…');
    expect(result.text.fullText).toBe(label);
  });
  it('wraps fixed text and shows ellipsis without altering fixed dimensions', () => {
    const node = {
      type: 'rect' as const,
      label: 'A label with far more text than can fit in this small fixed rectangle',
      width: 120,
      height: 64,
    };
    const text = layoutNodeText(node, options);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0]).toContain('…');
    expect(text.truncated).toBe(true);
    expect(text.fullText).toBe(node.label);
    expect(node.width).toBe(120);
    expect(layoutNodeText({ ...node, width: 24, height: 24 }, options).lines).toEqual([]);
  });
  it('uses safe inscribed text regions for diamonds and ellipses', () => {
    for (const type of ['diamond', 'ellipse', 'circle'] as const) {
      const result = measureNode({ type, label: 'Inside shape' }, options);
      const { x, y, availableWidth, availableHeight } = result.text;
      const dx = Math.abs(x + availableWidth - result.width / 2) / (result.width / 2);
      const dy = Math.abs(y + availableHeight - result.height / 2) / (result.height / 2);
      expect(type === 'diamond' ? dx + dy : dx * dx + dy * dy).toBeLessThanOrEqual(1);
    }
  });
  it('rejects bad metrics and invalid text bounds', () => {
    expect(() =>
      measureNode({ type: 'rect', label: 'x' }, { measurer: { measure: () => NaN } }),
    ).toThrow('invalid width');
    expect(() => wrapText('x', 0, options)).toThrow();
    expect(() => fitText('x', Infinity, 24, options)).toThrow();
    expect(() =>
      layoutNodeText({ type: 'rect', label: 'x', width: 0, height: 24 }, options),
    ).toThrow();
  });
  it('sets the shared canvas font and explicitly marks estimated metrics', () => {
    const context = { font: '', measureText: vi.fn(() => ({ width: 42 }) as TextMetrics) };
    expect(createCanvasTextMeasurer(context).measure('hello', 18, 600)).toBe(42);
    expect(context.font).toContain('600 18px Arial');
    expect(
      measureNode({ type: 'rect', label: 'Headless' }, { measurer: estimatedTextMeasurer })
        .estimated,
    ).toBe(true);
  });
  it('waits for font readiness before recomputing preliminary metrics', async () => {
    let ready = false;
    const fonts = {
      load: vi.fn(async () => {
        ready = true;
        return [];
      }),
      ready: Promise.resolve({} as FontFaceSet),
    };
    const measurer = { measure: (text: string) => text.length * (ready ? 16 : 4) };
    const before = measureNode({ type: 'rect', label: 'Font readiness' }, { measurer });
    await prepareLayoutFonts(fonts);
    const after = measureNode({ type: 'rect', label: 'Font readiness' }, { measurer });
    expect(fonts.load).toHaveBeenCalledWith(FONT_CSS);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.text.height % LINE_HEIGHT).toBe(0);
  });
});
