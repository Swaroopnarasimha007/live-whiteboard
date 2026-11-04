# Streaming integration

Agent 5 owns `src/stream`. Import `createStreamConsumer`, `MockGenerationTransport` and the `GenerationTransport` type from its barrel. No provider, HTTP service, microphone or speech scheduler is connected.

```ts
const consumer = createStreamConsumer({
  store,
  isInteractionInProgress: () => editor.getSnapshot().interactionInProgress,
});
const result = await consumer.consume(request, new MockGenerationTransport());
// consumer.cancel(); consumer.dispose() before disposing the store.
```

Create a fresh full GenerationRequest from committed scene geometry before each new request. The consumer schema-validates, clones and freezes it. New requests require the current revision and epoch; active manual gestures/labels defer starting. Agent 6's implemented [session/context integration](session.md) supplies the budgeted builder, transcript scheduling and request identities. `src/app/streamPreview.ts` remains a one-shot developer regression control using that builder.

## Framing and application

`GenerationTransport.generate(request, signal)` yields arbitrary Uint8Array chunks. A future HTTP adapter can implement this same interface over a POST response reader and release/cancel its reader on abort. The consumer owns incremental fatal UTF-8 decoding, LF/CRLF framing and the final record without LF. Escaped newlines stay within JSON strings. Invalid UTF-8, JSON, schemas and markdown fences are diagnosed per completed record; later lines continue. Blank lines do not consume sequence numbers.

Hard bounds: completed record 64 KiB (excluding CRLF), partial byte buffer 128 KiB, ready queue 2,000 operations and 200 retained diagnostics. Options may lower these bounds for tests. Oversized records or queue overflow abort with a visible error. Already accepted ready operations drain on transport/framing errors; explicit cancellation instead discards and counts queued operations. No structural operation disappears silently. Semantic dependencies remain the store's separate 200-command pending queue.

Each nonblank record receives a zero-based sequence, including invalid records, so deterministic retries retain later operation identities. Request ID, sequence, original base revision, epoch and request-scoped transaction ID are attached outside model JSON. Request-local IDs receive idPrefix once; canonical IDs present in context, including manual endpoints and placement anchors, retain their original values. The shared operation schema revalidates normalized IDs/defaults. The dispatcher remains responsible for locks, tombstones, active edits, stale/manual protection and dependencies.

Ready operations apply on the next animation frame, preserving order, within an 8 ms cooperative budget. One indivisible dispatcher operation can exceed that time; it cannot be preempted. No timer adds consumer latency. Node tests use a timer fallback; the scheduler also accepts an injected FrameClock. The parser and validation run during byte consumption; this is not a worker-based parser or a measured FPS guarantee.

## Lifecycle and retry

One consumer admits one active request. `consume` returns a terminal StreamResult. `isActive()` remains true until async cleanup completes, including after synchronous cancellation; session scheduling uses it before opening a new request. `getSnapshot/subscribe` expose receiving/draining/completed/incomplete/cancelled/error/disposed status, counters and diagnostics. Invalid or rejected records produce incomplete; framing/queue/transport failures produce error, possibly with accepted partial work. `firstAppliedMs` measures dispatch, not screen presentation. The canvas separately exposes actual scene-layer draw instrumentation.

`cancel`, external AbortSignal, store session invalidation and disposal synchronously disable subsequent dispatches and clear scheduled work. Waiting for iterator.next is raced with cancellation, so an uncooperative transport cannot keep the consumer waiting. Iterator return is best effort and never awaited indefinitely. The transport itself must release its own external resources; ignored promises cannot be forcibly terminated. The mock clears its abortable delays/listeners. finishRequest runs after draining, or during cancellation cleanup, rejecting unresolved dependencies.

There is no automatic replay. To retry, pass the **same original request**, same record ordering and IDs, with `{ retry: true }`. Do not refresh its base revision, prefix or transcript. The store reopens failed receipts, retaining accepted receipts and original additions. A malformed line must occupy the same position on replay; changing accepted content produces replay conflict. Manual edits after the original request remain protected. Epoch changes require a new request; old requests cannot reopen. Starting a new request builds fresh context and uses new identities.

Store integration adds beginRequest(requestId, epoch, retry), getOperationResult(requestId, sequence) and subscribeSessionInvalidation(listener). The last method observes generation-only cancellation as well as reset/import/disposal, even without a scene commit. Generated transaction deduplication is scoped to epoch/source/request/transaction; manual transaction scope is unchanged. Pending operation receipts allow the consumer to report eventual application/rejection accurately.

## Mock scenarios and verification

MockGenerationTransport accepts a supplied fixture or `buildDemoOperations(request)`, a seed, min/max chunk sizes, burst size/delay, per-record/tail delay, CRLF, final-newline toggle, malformed insertion and byte-offset disconnect. Fragmentation and failure offsets are deterministic; wall-clock timing depends on browser scheduling. Fixture payloads are capped at 4 MiB.

The standard fixture selects operations by DEMO_SEGMENTS values: demo-browser, demo-server, demo-edge, demo-correction, demo-topic, demo-database, demo-unicode and demo-disorder. It references existing Browser/Server nodes and a manually created Database in the active section. Unknown transcript IDs generate no operations. Topic changes require the explicit demo-topic segment; prose and timers never infer them.

Run `npm run dev`, then **Run mock stream**. Watch sections/nodes/edges arrive incrementally. Cancel and Retry mock demonstrate explicit continuation using the pinned request. Re-running after completion uses fresh context and avoids duplicating the existing flow. The renderer fixture remains a separate direct-command tool. Neither mode autosaves in the current app.

Unit tests cover byte boundaries, Unicode, limits, scheduling, error recovery, pending dependencies, disconnect/retry, manual conflicts and cancellation. `npm run test:stream-browser` checks actual Chromium canvas draw before transport completion, context reuse, cancel/retry and fragmented fault recovery at 2× DPI. Browser timing/FPS acceptance and real speech/HTTP integration belong to later stages.
