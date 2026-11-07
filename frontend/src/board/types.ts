import type Konva from 'konva';
import type { Node, Point, Scene, Viewport } from '../contracts';
import type { ReactNode } from 'react';
import type { ViewportController } from './viewport';

export interface BoardPointer {
  screen: Point;
  world: Point;
  nativeEvent: PointerEvent;
  sectionId: string | null;
}
export interface BoardInteractions {
  onNodePointerDown?: (id: string, event: BoardPointer) => void;
  onNodeDoubleClick?: (id: string, event: Konva.KonvaEventObject<MouseEvent>) => void;
  onEdgePointerDown?: (id: string, event: BoardPointer) => void;
  onCanvasPointerDown?: (event: BoardPointer) => void;
  onNodeDragStart?: (id: string, event: Konva.KonvaEventObject<DragEvent>) => void;
  onNodeDragMove?: (id: string, event: Konva.KonvaEventObject<DragEvent>) => void;
  onNodeDragEnd?: (id: string, event: Konva.KonvaEventObject<DragEvent>) => void;
  onNodeTransformStart?: (id: string, event: Konva.KonvaEventObject<Event>) => void;
  onNodeTransform?: (id: string, event: Konva.KonvaEventObject<Event>) => void;
  onNodeTransformEnd?: (id: string, event: Konva.KonvaEventObject<Event>) => void;
  nodeDraggable?: (node: Node) => boolean;
  onNodeRef?: (id: string, node: Konva.Group | null) => void;
  onNavigationStart?: () => void;
}
export type NodePreview = Pick<Node, 'x' | 'y' | 'width' | 'height'>;
export interface WhiteboardProps {
  scene: Scene;
  viewport: ViewportController;
  grid?: boolean;
  cursor?: string;
  tool?: 'select' | 'hand';
  selectedIds?: readonly string[];
  /** Optional explicit generation topic from Agent 6, separate from browsing selection. */
  liveSectionId?: string | null;
  previews?: Readonly<Record<string, NodePreview>>;
  /** Native Transformer keeps these node groups' canonical children while it scales them. Routes still use previews. */
  nativeTransformIds?: readonly string[];
  interactions?: BoardInteractions;
  interactionOverlay?: ReactNode;
  onStageReady?: (stage: Konva.Stage | null) => void;
  onDraw?: (event: { revision: number; viewport: Viewport; time: number }) => void;
  ariaLabel?: string;
}
export interface WhiteboardHandle {
  getStage(): Konva.Stage | null;
  getNodeRef(id: string): Konva.Group | undefined;
}
