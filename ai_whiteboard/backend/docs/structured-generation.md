# Structured generation and nonblocking recovery

Local `backend/config/settings.yaml` enables `structured_output: true` and
`structured_output_streaming: false` in the active Groq profile's capabilities.
Restart the backend and refresh the frontend to use it. No model switch is made.

Groq waits for one complete JSON response. OpenRouter profiles may enable both
capabilities when the pinned endpoint supports them. Streaming JSON is buffered
until the complete envelope arrives and validates; incomplete JSON never changes
the board. This release does not provide progressive structured rendering.
There is no automatic provider switch or second paid request on failure.

The response schema derives from the operation contracts. A schema transformation
adds provider-required fields and removes unsupported union/discriminator metadata.
Nullable provider fields normalize to omitted optional wire fields. This is a
defined wire conversion, not JSON repair. Standard JSON and JSON Schema validation
are used. Complete-response HTTP payloads and streamed text have a 1 MiB limit.

Existing entities receive request-local aliases. New IDs use a local prefix which
the adapter expands to canonical request IDs. References, protection, and layout
continue through the existing validators and frontend layout engine. Invalid
operations do not stop valid siblings in structured mode. Unresolved dependencies
are rejected by the existing reconciliation path.

Backend-mode failures no longer pin the generation queue. Failed transcript
segments are reconsidered with new speech using a new request and current board.
Session options configure `deferredMaxAttempts` (2 total attempts by default),
`deferredMaxAgeMs` (30000), and `deferredMaxSegments` (32). Transcript character
budgets still apply. Reset clears deferred work. Cancellation retains explicit
recovery behavior. No new speech means no automatic retry or extra provider call.

Recovery currently tracks failure conservatively at batch level: partial batches
may be reconsidered together, with the current board provided to avoid duplicates.
It does not prove semantic coverage or infer that every fact was drawn. Empty
structured responses must provide a reason; that reason is not a factual guarantee.
Successful transcript history is not resent in full.

Validation uses offline provider fixtures; live Groq/OpenRouter schema acceptance,
model quality, and latency must be measured separately. No paid calls were made.

Placement uses a provider-only nullable `placement` field: either `{at:[x,y]}`,
`{place:{rightOf:ID}}` (also leftOf/above/below), or null for automatic layout.
NodeAdd remains an object definition. The adapter explicitly maps this field to
canonical at/place fields; it never chooses between conflicting model values.
This avoids a union-only NodeAdd definition nested inside the operation union.
Both placement strategies cannot be supplied together.

For model evaluation, compare `generation.provider_end` duration, token usage,
warnings, and unresolved references with frontend `consumer.end` applied/rejected
counts. `text_delivery=buffered_response` means first-text timing is response-ready
timing, not first-token latency. Missing usage stays null. Whisper duration is
logged separately in `speech.chunk_finalized`. Provider errors log allowlisted
codes, parameter names and explanation categories, never raw messages or failed
generation bodies. `json_validate_failed` is an output failure, not a configuration
failure. Unknown upstream codes remain unrecognized rather than exposing content.

Retest with GPT-OSS 20B using short single concepts, a complete client/gateway/
authentication/database explanation, and a later addition to an existing board.
Assess whether the requested entities and relationships actually appear alongside
the log counts: successful operation validation alone does not prove coverage.
