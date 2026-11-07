import type { MeasurableNode, Shape } from '../contracts';
import {
  FONT_CSS,
  FONT_FAMILY,
  FONT_SIZE,
  LINE_HEIGHT,
  MAX_NODE_SIZE,
  MAX_TEXT_WIDTH,
  MIN_NODE_SIZE,
  NODE_PADDING,
  TEXT_PADDING,
} from './constants';

export interface TextMeasurer {
  measure(text: string, fontSize?: number, weight?: number): number;
  readonly estimated?: boolean;
}
export interface TextOptions {
  measurer?: TextMeasurer;
}
export interface TextLayout {
  lines: readonly string[];
  width: number;
  height: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  truncated: boolean;
  fullText: string;
}
export interface NodeMeasurement {
  width: number;
  height: number;
  text: TextLayout & { x: number; y: number; availableWidth: number; availableHeight: number };
  estimated: boolean;
}

/** Explicit deterministic headless fallback; browser composition uses canvas metrics. */
export const estimatedTextMeasurer: TextMeasurer = Object.freeze({
  estimated: true,
  measure(text: string, fontSize = FONT_SIZE) {
    return Array.from(text).reduce(
      (sum, char) =>
        sum +
        (/\s/u.test(char)
          ? 0.3
          : /[ilI.,'!|]/u.test(char)
            ? 0.28
            : /[MW@]/u.test(char)
              ? 0.9
              : (char.codePointAt(0) ?? 0) > 0x2ff
                ? 1
                : 0.56) *
          fontSize,
      0,
    );
  },
});

export function createCanvasTextMeasurer(
  context?: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
): TextMeasurer {
  const canvasContext =
    context ??
    (typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null);
  if (!canvasContext)
    throw new Error(
      'Canvas text measurement is unavailable; inject a TextMeasurer for headless use',
    );
  return {
    estimated: false,
    measure(text, fontSize = FONT_SIZE, weight = 400) {
      canvasContext.font = `${weight} ${fontSize}px ${FONT_FAMILY}`;
      return canvasContext.measureText(text).width;
    },
  };
}
let browserMeasurer: TextMeasurer | undefined;
export function getTextMeasurer(options: TextOptions = {}): TextMeasurer {
  if (options.measurer) return options.measurer;
  if (typeof document === 'undefined') return estimatedTextMeasurer;
  return (browserMeasurer ??= createCanvasTextMeasurer());
}

/** Await BEFORE composing the store; recompute any preliminary measurements after this resolves. */
export async function prepareLayoutFonts(
  fonts: Pick<FontFaceSet, 'load' | 'ready'> = document.fonts,
): Promise<void> {
  await Promise.all([
    fonts.load(FONT_CSS),
    fonts.load(`600 18px ${FONT_FAMILY}`),
    fonts.load(`14px ${FONT_FAMILY}`),
  ]);
  await fonts.ready;
}

function measureWith(measurer: TextMeasurer, size: number, weight = 400) {
  const cache = new Map<string, number>();
  return (text: string) => {
    let width = cache.get(text);
    if (width === undefined) {
      width = measurer.measure(text, size, weight);
      if (!Number.isFinite(width) || width < 0)
        throw new Error('Text measurer returned an invalid width');
      cache.set(text, width);
    }
    return width;
  };
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);

export function wrapText(
  text: string,
  maxWidth: number,
  options: TextOptions & { fontSize?: number; weight?: number } = {},
): string[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0)
    throw new Error('Text wrapping requires a positive finite width');
  const measure = measureWith(
    getTextMeasurer(options),
    options.fontSize ?? FONT_SIZE,
    options.weight,
  );
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    const flush = () => {
      lines.push(line.trimEnd());
      line = '';
    };
    for (const token of paragraph.split(/(\s+)/u).filter(Boolean)) {
      if (/^\s+$/u.test(token)) {
        if (line) line += token;
        continue;
      }
      if (line && measure(line + token) <= maxWidth) {
        line += token;
        continue;
      }
      if (line) flush();
      if (measure(token) <= maxWidth) {
        line = token;
        continue;
      }
      for (const char of graphemes(token)) {
        if (line && measure(line + char) > maxWidth) flush();
        line += char;
      }
    }
    flush();
  }
  return lines;
}

export function fitText(
  text: string,
  width: number,
  height: number,
  options: TextOptions & { fontSize?: number; lineHeight?: number; weight?: number } = {},
): TextLayout {
  if (![width, height].every(Number.isFinite) || width < 0 || height < 0)
    throw new Error('Invalid text bounds');
  const fontSize = options.fontSize ?? FONT_SIZE;
  const lineHeight = options.lineHeight ?? LINE_HEIGHT;
  if (
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    !Number.isFinite(lineHeight) ||
    lineHeight <= 0
  )
    throw new Error('Invalid typography');
  const measure = measureWith(getTextMeasurer(options), fontSize, options.weight);
  const all = width > 0 ? wrapText(text, width, { ...options, fontSize }) : [];
  const count = Math.floor(height / lineHeight);
  const lines = all.slice(0, count);
  let truncated = lines.length < all.length || (text.length > 0 && !lines.length);
  for (let index = 0; index < lines.length; index++) {
    const original = lines[index]!;
    if (measure(original) <= width && !(truncated && index === lines.length - 1)) continue;
    const chars = graphemes(original);
    while (chars.length && measure(chars.join('') + '…') > width) chars.pop();
    lines[index] = measure('…') <= width ? chars.join('') + '…' : '';
    truncated = true;
  }
  return {
    lines,
    width: Math.max(0, ...lines.map(measure)),
    height: lines.length * lineHeight,
    fontFamily: FONT_FAMILY,
    fontSize,
    fontWeight: options.weight ?? 400,
    lineHeight,
    truncated,
    fullText: text,
  };
}

function shapeTextBox(type: Shape, width: number, height: number) {
  const padding = type === 'text' ? TEXT_PADDING : NODE_PADDING;
  const factor = type === 'diamond' ? 2 : ['circle', 'ellipse'].includes(type) ? Math.SQRT2 : 1;
  const availableWidth = Math.max(0, width / factor - 2 * padding);
  const availableHeight = Math.max(0, height / factor - 2 * padding);
  return {
    x: (width - availableWidth) / 2,
    y: (height - availableHeight) / 2,
    availableWidth,
    availableHeight,
  };
}

export function layoutNodeText(
  node: MeasurableNode & { width: number; height: number },
  options: TextOptions = {},
): NodeMeasurement['text'] {
  if (
    ![node.width, node.height].every(
      (n) => Number.isFinite(n) && n >= MIN_NODE_SIZE && n <= MAX_NODE_SIZE,
    )
  )
    throw new Error('Invalid node dimensions');
  const box = shapeTextBox(node.type, node.width, node.height);
  return { ...fitText(node.label, box.availableWidth, box.availableHeight, options), ...box };
}

export function measureNode(node: MeasurableNode, options: TextOptions = {}): NodeMeasurement {
  const measurer = getTextMeasurer(options);
  const measure = measureWith(measurer, FONT_SIZE);
  const naturalWidth = Math.max(0, ...node.label.replace(/\r\n?/g, '\n').split('\n').map(measure));
  const contentWidth = Math.min(MAX_TEXT_WIDTH, Math.max(1, naturalWidth));
  const lines = wrapText(node.label, contentWidth, { measurer });
  const padding = node.type === 'text' ? TEXT_PADDING : NODE_PADDING;
  const factor =
    node.type === 'diamond' ? 2 : ['circle', 'ellipse'].includes(node.type) ? Math.SQRT2 : 1;
  const minWidth = node.type === 'text' ? 24 : node.type === 'circle' ? 88 : 120;
  const minHeight = node.type === 'text' ? 24 : node.type === 'circle' ? 88 : 64;
  let width = Math.max(minWidth, Math.ceil((contentWidth + 2 * padding) * factor));
  let height = Math.max(minHeight, Math.ceil((lines.length * LINE_HEIGHT + 2 * padding) * factor));
  if (node.type === 'circle') width = height = Math.max(width, height);
  width = Math.min(MAX_NODE_SIZE, width);
  height = Math.min(MAX_NODE_SIZE, height);
  return {
    width,
    height,
    text: layoutNodeText({ ...node, width, height }, { measurer }),
    estimated: !!measurer.estimated,
  };
}
