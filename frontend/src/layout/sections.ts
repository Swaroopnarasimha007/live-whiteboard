import type { Box, Node, Point, Scene, Section } from '../contracts';
import {
  SECTION_GAP,
  SECTION_PADDING,
  SECTION_TITLE_GAP,
  SECTION_TITLE_LINE_HEIGHT,
  SECTION_TITLE_MAX_WIDTH,
  SECTION_TITLE_SIZE,
} from './constants';
import { fitText, getTextMeasurer, wrapText, type TextLayout, type TextOptions } from './text';

export function getSectionTitleLayout(
  title: string,
  width = SECTION_TITLE_MAX_WIDTH,
  options: TextOptions = {},
): TextLayout {
  const available = Math.max(1, Math.min(width, SECTION_TITLE_MAX_WIDTH));
  const lines = wrapText(title, available, {
    ...options,
    fontSize: SECTION_TITLE_SIZE,
    weight: 600,
  });
  return fitText(title, available, Math.max(1, lines.length) * SECTION_TITLE_LINE_HEIGHT, {
    ...options,
    fontSize: SECTION_TITLE_SIZE,
    lineHeight: SECTION_TITLE_LINE_HEIGHT,
    weight: 600,
  });
}

export interface SectionBoundsOptions extends TextOptions {
  contentBounds?: readonly Box[];
}
export function getSectionBounds(
  section: Pick<Section, 'id' | 'title'>,
  nodes: readonly Node[],
  options: SectionBoundsOptions = {},
): Box {
  const content = nodes.filter((node) => node.sectionId === section.id);
  const bounds = [...content, ...(options.contentBounds ?? [])];
  const left = Math.min(0, ...bounds.map((n) => n.x));
  const top = Math.min(0, ...bounds.map((n) => n.y));
  const right = Math.max(0, ...bounds.map((n) => n.x + n.width));
  const bottom = Math.max(0, ...bounds.map((n) => n.y + n.height));
  const title = getSectionTitleLayout(section.title, SECTION_TITLE_MAX_WIDTH, options);
  const width = Math.max(
    320,
    right - left + 2 * SECTION_PADDING,
    title.width + 2 * SECTION_PADDING,
  );
  const header = SECTION_TITLE_GAP + title.height;
  return {
    x: left - SECTION_PADDING,
    y: top - SECTION_PADDING - header,
    width: Math.ceil(width),
    height: Math.ceil(Math.max(160, bottom - top + 2 * SECTION_PADDING + header)),
  };
}

export function getSectionHeader(
  section: Section,
  options: TextOptions = {},
): TextLayout & { x: number; y: number } {
  return {
    ...getSectionTitleLayout(section.title, section.bounds.width - 2 * SECTION_PADDING, options),
    x: section.bounds.x + SECTION_PADDING,
    y: section.bounds.y + SECTION_PADDING,
  };
}

export interface SectionLayoutOptions extends TextOptions {
  previousSections?: Scene['sections'];
  sectionExtras?: ReadonlyMap<string, readonly Box[]>;
}
export function layoutSections(
  scene: Scene,
  nodes: readonly Node[] = Object.values(scene.nodes),
  options: SectionLayoutOptions = {},
): Record<string, { origin: Point; bounds: Box }> {
  const result: Record<string, { origin: Point; bounds: Box }> = {};
  const grouped = new Map<string, Node[]>();
  for (const node of nodes) {
    const group = grouped.get(node.sectionId) ?? [];
    group.push(node);
    grouped.set(node.sectionId, group);
  }
  const measurer = getTextMeasurer(options);
  let previous: { origin: Point; bounds: Box } | undefined;
  for (const section of Object.values(scene.sections).sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  )) {
    const bounds = getSectionBounds(section, grouped.get(section.id) ?? [], {
      measurer,
      contentBounds: options.sectionExtras?.get(section.id) ?? [],
    });
    const minY = previous
      ? previous.origin.y + previous.bounds.y + previous.bounds.height + SECTION_GAP - bounds.y
      : section.origin.y;
    // Existing sections never move up on shrink. New sections append exactly, including
    // imported boards whose first origin is negative rather than zero.
    const isNew =
      options.previousSections !== undefined &&
      !Object.hasOwn(options.previousSections, section.id);
    const origin = {
      x: section.origin.x,
      y: isNew && previous ? minY : Math.max(section.origin.y, minY),
    };
    result[section.id] = { origin, bounds };
    previous = result[section.id];
  }
  return result;
}

export function getSectionOriginDeltas(
  previous: Pick<Scene, 'sections'>,
  next: Record<string, { origin: Point }>,
): Record<string, Point> {
  const deltas: Record<string, Point> = {};
  for (const [id, section] of Object.entries(next)) {
    const old = previous.sections[id];
    if (old && (old.origin.x !== section.origin.x || old.origin.y !== section.origin.y))
      deltas[id] = { x: section.origin.x - old.origin.x, y: section.origin.y - old.origin.y };
  }
  return deltas;
}
