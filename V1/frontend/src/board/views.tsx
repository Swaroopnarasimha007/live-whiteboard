import { memo, useCallback, useContext } from 'react';
import type Konva from 'konva';
import { Arrow, Circle, Ellipse, Group, Line, Rect, Text } from 'react-konva';
import type { Edge, Node, Point, Section } from '../contracts';
import { getSectionHeader, layoutNodeText, ROUND_RECT_RADIUS, type RoutedEdge } from '../layout';
import type { BoardInteractions, BoardPointer } from './types';
import { BOARD_THEME, SHAPE_COLORS } from './theme';
import { ColorModeContext, DARK_THEME } from '../styles/colorMode';
import { useCanvasEntrance } from './motion';

export const SectionView = memo(function SectionView({ section }: { section: Section }) {
  const entrance = useCanvasEntrance(`section:${section.id}`);
  const paint = useContext(ColorModeContext) === 'dark' ? DARK_THEME : BOARD_THEME;
  const title = getSectionHeader(section);
  return (
    <Group
      ref={entrance}
      x={section.origin.x}
      y={section.origin.y}
      listening={false}
      name={`section-${section.id}`}
    >
      <Rect
        {...section.bounds}
        fill={paint.section}
        stroke={paint.border}
        strokeWidth={1}
        cornerRadius={12}
      />
      <Text
        x={title.x}
        y={title.y}
        width={section.bounds.width - 64}
        height={title.height}
        text={title.lines.join('\n')}
        fontFamily={title.fontFamily}
        fontSize={title.fontSize}
        fontStyle={String(title.fontWeight)}
        lineHeight={title.lineHeight / title.fontSize}
        fill={paint.text}
        wrap="none"
        listening={false}
      />
    </Group>
  );
});
interface NodeViewProps {
  node: Node;
  origin: Point;
  canDrag: boolean;
  interactions: BoardInteractions;
  pointer: (event: Konva.KonvaEventObject<PointerEvent>, sectionId: string | null) => BoardPointer;
  register: (id: string, node: Konva.Group | null) => void;
}
export const NodeView = memo(
  function NodeView({ node, origin, canDrag, interactions, pointer, register }: NodeViewProps) {
    const entrance = useCanvasEntrance(`node:${node.id}`);
    const ref = useCallback(
      (value: Konva.Group | null) => {
        entrance.current = value;
        register(node.id, value);
      },
      [register, node.id, entrance],
    );
    const dark = useContext(ColorModeContext) === 'dark';
    const text = layoutNodeText(node);
    const colors = SHAPE_COLORS[node.color];
    const shape = { fill: colors.fill, stroke: colors.stroke, strokeWidth: 1.5 };
    return (
      <Group
        ref={ref}
        id={node.id}
        name="board-node"
        x={origin.x + node.x}
        y={origin.y + node.y}
        width={node.width}
        height={node.height}
        draggable={canDrag && !node.locked && !!interactions.nodeDraggable?.(node)}
        onPointerDown={(event) => {
          event.cancelBubble = true;
          interactions.onNodePointerDown?.(node.id, pointer(event, node.sectionId));
        }}
        onDblClick={(event) => interactions.onNodeDoubleClick?.(node.id, event)}
        onDragStart={(event) => interactions.onNodeDragStart?.(node.id, event)}
        onDragMove={(event) => interactions.onNodeDragMove?.(node.id, event)}
        onDragEnd={(event) => interactions.onNodeDragEnd?.(node.id, event)}
        onTransformStart={(event) => interactions.onNodeTransformStart?.(node.id, event)}
        onTransform={(event) => interactions.onNodeTransform?.(node.id, event)}
        onTransformEnd={(event) => interactions.onNodeTransformEnd?.(node.id, event)}
      >
        {node.type === 'rect' && <Rect width={node.width} height={node.height} {...shape} />}
        {node.type === 'roundRect' && (
          <Rect
            width={node.width}
            height={node.height}
            cornerRadius={Math.min(ROUND_RECT_RADIUS, node.width / 2, node.height / 2)}
            {...shape}
          />
        )}
        {node.type === 'circle' && (
          <Circle x={node.width / 2} y={node.height / 2} radius={node.width / 2} {...shape} />
        )}
        {node.type === 'ellipse' && (
          <Ellipse
            x={node.width / 2}
            y={node.height / 2}
            radiusX={node.width / 2}
            radiusY={node.height / 2}
            {...shape}
          />
        )}
        {node.type === 'diamond' && (
          <Line
            points={[
              node.width / 2,
              0,
              node.width,
              node.height / 2,
              node.width / 2,
              node.height,
              0,
              node.height / 2,
            ]}
            closed
            {...shape}
          />
        )}
        {node.type === 'text' && (
          <Rect width={node.width} height={node.height} fill="rgba(0,0,0,0)" />
        )}
        <Text
          x={text.x}
          y={text.y}
          width={text.availableWidth}
          height={text.availableHeight}
          text={text.lines.join('\n')}
          fontFamily={text.fontFamily}
          fontSize={text.fontSize}
          fontStyle={String(text.fontWeight)}
          lineHeight={text.lineHeight / text.fontSize}
          align="center"
          verticalAlign="middle"
          wrap="none"
          fill={dark && node.type === 'text' ? DARK_THEME.text : BOARD_THEME.text}
          listening={false}
        />
        {text.truncated && (
          <Circle x={node.width - 5} y={5} radius={3} fill={colors.stroke} listening={false} />
        )}
      </Group>
    );
  },
  (previous, next) =>
    previous.node === next.node &&
    previous.origin.x === next.origin.x &&
    previous.origin.y === next.origin.y &&
    previous.canDrag === next.canDrag &&
    previous.interactions === next.interactions &&
    previous.pointer === next.pointer &&
    previous.register === next.register,
);
export const EdgeView = memo(function EdgeView({
  edge,
  route,
  interactions,
  pointer,
}: {
  edge: Edge;
  route: RoutedEdge;
  interactions: BoardInteractions;
  pointer: NodeViewProps['pointer'];
}) {
  const entrance = useCanvasEntrance(`edge:${edge.id}`);
  const dark = useContext(ColorModeContext) === 'dark';
  const stroke = dark ? SHAPE_COLORS[edge.color].fill : SHAPE_COLORS[edge.color].stroke;
  const lineProps = { points: [...route.points], stroke, strokeWidth: 1.5, hitStrokeWidth: 12 };
  return (
    <Group
      ref={entrance}
      id={edge.id}
      name="board-edge"
      onPointerDown={(event) => {
        event.cancelBubble = true;
        interactions.onEdgePointerDown?.(edge.id, pointer(event, edge.sectionId));
      }}
    >
      {edge.kind === 'arrow' && route.arrowLength > 0 ? (
        <Arrow
          {...lineProps}
          fill={stroke}
          pointerLength={route.arrowLength}
          pointerWidth={route.arrowWidth}
        />
      ) : (
        <Line {...lineProps} />
      )}
      {route.label && (
        <Group x={route.label.box.x} y={route.label.box.y}>
          <Rect
            width={route.label.box.width}
            height={route.label.box.height}
            fill={dark ? DARK_THEME.surface : route.label.background}
            cornerRadius={3}
          />
          <Text
            x={route.label.padding}
            y={route.label.padding}
            width={route.label.text.width}
            height={route.label.text.height}
            text={route.label.text.lines.join('\n')}
            fontFamily={route.label.text.fontFamily}
            fontSize={route.label.text.fontSize}
            fontStyle={String(route.label.text.fontWeight)}
            lineHeight={route.label.text.lineHeight / route.label.text.fontSize}
            wrap="none"
            align="center"
            fill={dark ? DARK_THEME.text : BOARD_THEME.text}
            listening={false}
          />
        </Group>
      )}
    </Group>
  );
});
