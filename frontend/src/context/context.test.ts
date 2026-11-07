import { describe, expect, it } from 'vitest';
import { manualNodeId, setup } from '../scene/test-helpers';
import {
  buildGenerationRequest,
  inspectGenerationRequest,
  type BuildGenerationRequestOptions,
} from './index';
function input(): BuildGenerationRequestOptions {
  const { store } = setup();
  return {
    scene: store.getSnapshot(),
    sessionEpoch: 0,
    sessionId: 'session1',
    requestId: 'r1',
    transcript: { segmentIds: ['t1'], text: 'Hello 世界 🌍', startMs: 0, endMs: 1000 },
    viewport: { x: 50, y: -70, scale: 2 },
    visibleWorldBounds: { x: -25, y: 35, width: 400, height: 300 },
    selectedIds: [],
    activeSectionId: null,
    interactionInProgress: false,
  };
}
describe('full immutable generation context', () => {
  it('includes current manual geometry, dimensions, defaults, sections and view without editor internals', () => {
    const { store, manual, addSection } = setup();
    addSection();
    store.dispatch(
      {
        op: 'node.add',
        id: manualNodeId,
        section: 'g_s',
        type: 'rect',
        label: 'Manual',
        at: [34, 56],
      },
      manual(),
    );
    expect(
      store.dispatch(
        { op: 'node.resize', id: manualNodeId, at: [222, -123], width: 333, height: 88 },
        manual(),
      ).status,
    ).toBe('applied');
    const request = buildGenerationRequest({
      ...input(),
      scene: store.getSnapshot(),
      activeSectionId: 'g_s',
      selectedIds: [manualNodeId],
    });
    expect(request.board.nodes[0]).toMatchObject({
      id: manualNodeId,
      x: 222,
      y: -123,
      width: 333,
      height: 88,
      source: 'manual',
      color: 'neutral',
      locked: false,
    });
    expect(request.baseRevision).toBe(store.getSnapshot().revision);
    expect(request.board.viewport).toEqual({ x: 50, y: -70, scale: 2 });
    expect(request.board.selectedIds).toEqual([manualNodeId]);
    expect(request.board.nodes[0]).not.toHaveProperty('lastManualRevision');
    expect(request.board).toMatchObject({ contextComplete: true, omittedEntityCount: 0 });
  });
  it('clones and deeply freezes snapshots independently of later source mutations', () => {
    const options = input();
    const request = buildGenerationRequest(options);
    options.viewport.x = 999;
    options.transcript.text = 'Later';
    expect(request.board.viewport.x).toBe(50);
    expect(request.transcript.text).toBe('Hello 世界 🌍');
    expect(() => {
      request.board.viewport.x = 8;
    }).toThrow();
    expect(Object.isFrozen(request.board.sections)).toBe(true);
  });
  it('measures UTF-8 bytes and accepts the exact budget without truncating anything', () => {
    const options = input();
    const request = buildGenerationRequest(options);
    const inspected = inspectGenerationRequest(request);
    expect(inspected.bytes).toBeGreaterThan(inspected.json.length);
    expect(buildGenerationRequest({ ...options, budgetBytes: inspected.bytes })).toEqual(request);
    expect(() => buildGenerationRequest({ ...options, budgetBytes: inspected.bytes - 1 })).toThrow(
      'Transcript is retained',
    );
  });
  it('defers active interactions and rejects invalid selections and budgets', () => {
    expect(() => buildGenerationRequest({ ...input(), interactionInProgress: true })).toThrow(
      'Finish the active edit',
    );
    expect(() => buildGenerationRequest({ ...input(), selectedIds: ['missing'] })).toThrow();
    expect(() => buildGenerationRequest({ ...input(), budgetBytes: 0 })).toThrow('Invalid context');
  });
});
