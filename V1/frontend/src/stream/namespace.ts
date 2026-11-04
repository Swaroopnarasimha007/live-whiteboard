import type { GenerationRequest, Operation } from '../contracts';
import { operationSchema } from '../contracts';

/** Canonical context IDs are preserved; request-local model IDs receive the current prefix once. */
export function namespaceOperation(operation: Operation, request: GenerationRequest): Operation {
  const known = new Set(
    [...request.board.sections, ...request.board.nodes, ...request.board.edges].map((e) => e.id),
  );
  const id = (value: string) =>
    known.has(value) || value.startsWith(request.idPrefix) || value.startsWith('m_')
      ? value
      : `${request.idPrefix}${value}`;
  let next: Operation;
  switch (operation.op) {
    case 'section.add':
      next = { ...operation, id: id(operation.id) };
      break;
    case 'node.add':
      next = {
        ...operation,
        id: id(operation.id),
        section: id(operation.section),
        ...(operation.place
          ? {
              place: Object.fromEntries(
                Object.entries(operation.place).map(([key, value]) => [key, id(value)]),
              ) as typeof operation.place,
            }
          : {}),
      };
      break;
    case 'edge.add':
      next = {
        ...operation,
        id: id(operation.id),
        section: id(operation.section),
        from: id(operation.from),
        to: id(operation.to),
      };
      break;
    default:
      next = { ...operation, id: id(operation.id) };
  }
  return operationSchema.parse(next);
}
