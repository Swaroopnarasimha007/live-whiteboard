import { describe, expect, it } from 'vitest';
import {
  commandMetaSchema,
  generationRequestSchema,
  manualCommandSchema,
  operationSchema,
  sceneSchema,
  viewportSchema,
} from './schemas';
import { invalidOperationExamples, operationExamples } from './examples';
import { setup } from '../scene/test-helpers';
import { layoutOutputSchema } from './layout';

describe('protocol schemas', () => {
  it('treats viewport translations as finite screen pixels rather than bounded world coordinates', () => {
    expect(viewportSchema.safeParse({ x: 400_000, y: -800_000, scale: 4 }).success).toBe(true);
    expect(viewportSchema.safeParse({ x: Infinity, y: 0, scale: 1 }).success).toBe(false);
  });
  it('permits viewport compensation across the full allowed origin range', () => {
    expect(
      layoutOutputSchema.safeParse({
        nodes: {},
        sections: {},
        anchorDelta: { x: 200_000, y: -200_000 },
      }).success,
    ).toBe(true);
    expect(
      layoutOutputSchema.safeParse({ nodes: {}, sections: {}, anchorDelta: { x: 200_001, y: 0 } })
        .success,
    ).toBe(false);
  });
  it('validates all operation examples and rejects invalid examples', () => {
    operationExamples.forEach((op) => expect(operationSchema.safeParse(op).success).toBe(true));
    invalidOperationExamples.forEach((op) =>
      expect(operationSchema.safeParse(op).success).toBe(false),
    );
  });
  it('defaults compact operations centrally', () => {
    expect(
      operationSchema.parse({ op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' }),
    ).toMatchObject({ kind: 'arrow', label: '', color: 'neutral' });
    expect(
      operationSchema.parse({
        op: 'node.add',
        id: 'g_n',
        section: 'g_s',
        type: 'rect',
        label: 'A',
      }),
    ).toHaveProperty('color', 'neutral');
  });
  it.each([NaN, Infinity, -Infinity, 100_001, -100_001])('rejects invalid coordinate %s', (x) => {
    expect(operationSchema.safeParse({ ...operationExamples[1], at: [x, 0] }).success).toBe(false);
  });
  it('rejects unknown keys, unsafe prototypes, accessors and cyclic input', () => {
    const base = { op: 'node.update', id: 'g_n', set: { label: 'Safe' } };
    expect(operationSchema.safeParse({ ...base, rotation: 15 }).success).toBe(false);
    expect(
      operationSchema.safeParse(
        JSON.parse('{"op":"node.update","id":"g_n","set":{"__proto__":{"polluted":true}}}'),
      ).success,
    ).toBe(false);
    expect(
      operationSchema.safeParse({ ...base, set: Object.create({ label: 'Inherited' }) }).success,
    ).toBe(false);
    const getter = {
      ...base,
      get set() {
        throw new Error('must not execute');
      },
    };
    expect(operationSchema.safeParse(getter).success).toBe(false);
    const cycle: Record<string, unknown> = { ...base };
    cycle.set = cycle;
    expect(operationSchema.safeParse(cycle).success).toBe(false);
    for (const id of ['toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'])
      expect(operationSchema.safeParse({ ...base, id }).success).toBe(false);
  });
  it('enforces labels, IDs and exclusive placement', () => {
    for (const label of ['', ' ', 'a'.repeat(501)])
      expect(operationSchema.safeParse({ ...operationExamples[1], label }).success).toBe(false);
    expect(manualCommandSchema.safeParse({ ...operationExamples[1], label: '' }).success).toBe(
      true,
    );
    expect(operationSchema.safeParse({ ...operationExamples[1], id: 'a'.repeat(65) }).success).toBe(
      false,
    );
    expect(
      operationSchema.safeParse({ ...operationExamples[1], place: { below: 'g_a' } }).success,
    ).toBe(false);
    expect(
      operationSchema.safeParse({ ...operationExamples[2], place: { below: 'g_a', above: 'g_b' } })
        .success,
    ).toBe(false);
  });
  it('requires complete generated metadata', () => {
    expect(
      commandMetaSchema.safeParse({ source: 'generated', sessionEpoch: 0, transactionId: 'tx' })
        .success,
    ).toBe(false);
  });
  it('rejects malformed imported scene relationships and geometry', () => {
    const { store, addSection, addNode } = setup();
    addSection();
    addNode();
    const scene = structuredClone(store.getSnapshot());
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    scene.nodes.g_n!.sectionId = 'missing';
    expect(sceneSchema.safeParse(scene).success).toBe(false);
    scene.nodes.g_n!.sectionId = 'g_s';
    scene.nodes.g_n!.width = 23;
    expect(sceneSchema.safeParse(scene).success).toBe(false);
    scene.nodes.g_n!.width = 80;
    scene.nodes.g_n!.type = 'circle';
    expect(sceneSchema.safeParse(scene).success).toBe(false);
    scene.nodes.g_n!.type = 'rect';
    scene.nodes.g_n!.revision = 999;
    expect(sceneSchema.safeParse(scene).success).toBe(false);
  });
  it('validates complete generation context and its cross references', () => {
    const request = {
      protocolVersion: 1,
      requestId: 'r1',
      sessionId: 's1',
      sessionEpoch: 0,
      baseRevision: 0,
      idPrefix: 'g_r1_',
      transcript: { segmentIds: ['t1'], text: 'Hello', startMs: 0, endMs: 100 },
      board: {
        activeSectionId: null,
        sections: [],
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, scale: 1 },
        visibleWorldBounds: { x: 0, y: 0, width: 800, height: 600 },
        selectedIds: [],
        contextComplete: true,
        omittedEntityCount: 0,
      },
    };
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      generationRequestSchema.safeParse({
        ...request,
        board: { ...request.board, contextComplete: false },
      }).success,
    ).toBe(false);
    expect(
      generationRequestSchema.safeParse({
        ...request,
        board: { ...request.board, selectedIds: ['missing'] },
      }).success,
    ).toBe(false);
    expect(
      generationRequestSchema.safeParse({
        ...request,
        transcript: { ...request.transcript, endMs: -1 },
      }).success,
    ).toBe(false);
  });
});
