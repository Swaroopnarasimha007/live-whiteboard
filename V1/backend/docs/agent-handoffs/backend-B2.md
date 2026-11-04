# B2 handoff — 2026-11-03

B2 is implemented; stopped before B3. This stage provides local diagram generation components and five separate real-provider adapters. It does **not** implement sessions, replay, HTTP generation delivery or the frontend HTTP/session bridge. Production session/generation endpoints remain explicit 501 stubs and the audio route still awaits B3 ownership/mounting.

## Checklist and delivered behavior

- [x] Fresh complete context validation, including actual node geometry, section origins, edge protections, identity/reference/revision rules and byte budgets.
- [x] Provider-independent prompt builder; transcript/board are serialized as user data, never interpolated into system instructions.
- [x] Explicit diagram registry with pinned settings/credential references, enabled-profile selection and safe readiness/preflight failures.
- [x] Separate Groq, OpenRouter, OpenAI, Gemini and Anthropic adapters, using the required API families and a shared async HTTP client/framing layer.
- [x] Normalized append-only answer deltas, cumulative usage snapshots, one validated terminal event, safe errors, and exclusion of explicitly marked reasoning/refusal/tool channels from the drawing parser.
- [x] Incremental bounded NDJSON operation parser: yield completed records immediately, warn on invalid records, reset the error streak on valid records, terminate after three consecutive invalid records, preserve the accepted prefix.
- [x] New-ID prefix checks; existing IDs stay canonical; node/edge type and same-section checks; manual/locked protections and incident-edge delete protection.
- [x] Bounded pending references for out-of-order additions; later arrivals must satisfy promised type/section; unresolved references yield diagnostics rather than a claim that the client applied them.
- [x] Operation/line/partial-buffer limits, connection/first-answer/idle-answer/total deadlines, explicit incomplete/failure outcomes and cancellation cleanup.
- [x] Context-aware local mock: reuse matching objects/edges, topic transition, no-op speech, delayed/fragmented/invalid/interrupted fixtures.
- [x] Fake-provider conformance and shared operation scenarios for all five adapters, with optional credentialed checks skipped explicitly by default.
- [x] App lifespan composition, safe B2 capabilities, dependency lock, local demo and setup/handoff documentation.
- [ ] B3 must provide real sessions, one active request per session, wire event persistence/sequences, HTTP streaming, replay, disconnect/reset ownership and frontend networking.
- [ ] B4/final integration must run listening-server/browser/provider credentialed acceptance tests, deployment/proxy checks and measured performance/quality benchmarks. No live API integration is labelled verified by these synthetic tests.

## Public exports and composition

`app.diagram` exports:

- `DiagramRegistry`, `GenerationService`, `PreparedGeneration`.
- `GenerationState`, `GenerationResult`, `OperationResult`, `WarningResult`, `CompletedResult`, `FailedResult`.

`app.diagram.interfaces` re-exports the frozen B0 `DiagramProvider`, `LLMRequest`, `LLMEvent`, `TextDelta`, `Usage`, `Finished`, `ProviderError`. Adapters do not expose HTTP/SDK objects to the service.

The app lifespan creates `app.state.diagram_registry` and `app.state.generation_service`, and registers registry shutdown on the B0 exit stack. Clients are instantiated lazily only when selected; startup makes no model catalog or generation calls. B1 speech remains independent and can process audio while B3 drives a diagram stream.

Capability stage is `B2`: `services.speech`/`services.diagram` are true, while `sessions`, `audio`, `generation`, `replay` remain false. The latter flags mean public endpoint/network integration is pending. Mock diagram readiness is true without keys. Real readiness means local prerequisites pass, not that an API key, model/account access, quota or output quality was verified remotely. Capabilities expose enabled IDs/display names/provider/capability flags and safe unavailable reasons; never keys, key references, raw options or filesystem paths.

## B3 integration contract

```python
service = app.state.generation_service
# B3 first validates session ownership/epoch/concurrency and selects the pinned profile.
prepared = service.prepare(generation_request, profile=session.diagram_profile)
state = GenerationState()  # Fresh per request; retained separately for safe diagnostics.
iterator = service.generate(prepared, state=state)
try:
    async for result in iterator:
        # B3 persists and wraps domain results with request/epoch/baseRevision/sequence.
        ...
finally:
    await iterator.aclose()
```

`prepare()` validates the snapshot/profile/options/limits and returns a frozen prepared object containing the serialized request snapshot, normalized `LLMRequest`, profile ID and configuration fingerprint. It never opens a network stream. Preflight errors are `ProviderError` with safe messages; B3 should translate invalid input/budgets/unavailable profiles to ordinary HTTP errors before committing response headers. Invalid snapshots use `invalid_output` at this boundary; B3 can map the preflight phase to 422. Budget errors use `context_too_large`. Do not pass browser data as a `PreparedGeneration`; only use the server's `prepare()` result.

`generate()` yields these provider-independent results:

| Result | Fields | B3 responsibility |
| --- | --- | --- |
| `OperationResult` | Pydantic `operation` | Persist/send an `operation` envelope with the original new wire sequence |
| `WarningResult` | `code`, safe `message`, optional parser `line` | Persist/send warning; no full-response repair |
| `CompletedResult` | `operation_count`, `warning_count` | Exactly one completed wire terminal |
| `FailedResult` | normalized `code`, safe `message`, `retryable`, optional `retry_after` | Failed wire terminal; retain earlier events/operations |

B2 deliberately does not assign transport sequence numbers, own session scheduling or retain replay records. A produced operation means validated for this request snapshot, **not applied to the canonical board**. The frontend's latest stale-edit/lock/tombstone checks remain authoritative. Every later request must supply a new browser snapshot; never reconstruct it from emitted operations.

B3 must preserve provider/request isolation: never regenerate under an old request ID to replay output, never invoke the model again to repair JSON, never splice fallback output, and never renumber operation events after replay. Before headers, a producer failure can be mapped to normal HTTP status; after headers, use a structured failed terminal. EOF without a terminal remains interrupted.

On `asyncio.CancelledError`, the service closes its provider iterator and re-raises; it does not invent a completed result. B3 owns the cancelled/interrupted wire terminal and replay retention. Closing the application registry is global shutdown cleanup; closing the request iterator must not close shared clients serving other requests. Shutdown should cancel B3 producers before the exit stack closes provider clients.

`GenerationState` records cumulative known usage, configured/effective profile/provider/model, fingerprint, optional upstream ID, local request-relative times to first answer delta/operation, elapsed duration, operation/warning counts and whether local iterator closure succeeded. `upstream_cancellation` remains `unknown`: closing a local stream does not establish remote cancellation or stopped billing. `local_stream_closed` is false when no iterator opened or closure could not be confirmed. Create a new state for every request. These metrics are instrumentation, not reported latency benchmarks.

## Context, prompts and parser rules

The complete request is capped at `server.max_request_bytes` (default 512 KiB); the board snapshot is capped at `diagram.max_context_bytes` (256 KiB). The B0 HTTP body boundary separately enforces raw body bytes. Pydantic cross-reference validation is re-run before provider use. Geometry, source/lock/revision fields, world bounds and selection are not rounded, laid out, truncated or replaced by a server cache.

Instructions list the existing six operations, shape/color enums, relative placement and 64-unit frontend gap, manual/locked protections, no-op behavior, topic transitions and no renderer-specific output. Transcript and board fields stay in a separate compact JSON user message. The model gets full committed context and the supplied request ID prefix.

The parser buffers only the current incomplete operation line. It validates complete records as they arrive and yields them immediately. It accepts a valid final record without newline only after a normalized `Finished('stop')`. A truncated final record fails visibly; a length/safety/tool/unknown stop never flushes a partial tail as success. Oversized completed lines are rejected with warnings; an oversized incomplete buffer or operation cap terminates visibly. Three consecutive invalid records terminate; valid records reset the counter.

The request-local table contains identity/type/section/protection hints, not layout or canonical geometry. New additions must use `idPrefix`; existing references are never prefixed again. Missing references can wait only when they use this request's prefix, and are bounded by `min(128, max_operations_per_request)`. Manual/locked nodes and edges cannot be updated/deleted. Deleting a node checks incident edge protections and creates request-local tombstones for the cascade. Sections cannot be deleted. Scene limits remain 100 sections/5000 combined nodes and edges. Unknown old IDs, conflicting types, wrong sections and ID reuse are rejected. Layout cycles or unresolved client operations still require frontend diagnostics; B2 does not compute layout.

## Provider implementations and options

All adapters use `httpx==0.28.1`, fixed official endpoints, TLS, no redirects, no automatic transport retries and no ambient proxy injection. No provider SDKs or extra provider packages are required. Secrets are pinned server-side and placed in headers; Gemini keys do not appear in URLs. Upstream error bodies are bounded and normalized without logging/returning raw messages. SSE framing handles UTF-8 fragmentation, comments, CRLF and multiline data with a 1 MiB event limit.

Some APIs identify a refusal only in terminal metadata after ordinary text deltas. Earlier ordinary text cannot be classified retroactively without buffering the whole response; it remains subject to operation validation, and a later refusal always fails the generation while preserving its validated prefix. Explicit refusal blocks and Gemini safety-marked frames are excluded before text reaches the parser.

| Provider / class | Endpoint / API | Normalization and output budget |
| --- | --- | --- |
| `groq` / `GroqDiagramProvider` | `api.groq.com/openai/v1/chat/completions` | Choice zero content only, usage/root `x_groq` accounting, finish reason plus `[DONE]`; verified `max_completion_tokens` or legacy `max_tokens` |
| `openrouter` / `OpenRouterDiagramProvider` | `openrouter.ai/api/v1/chat/completions` | Choice zero, comment frames ignored, repeated identical finish/accounting frames deduplicated, `[DONE]` required; `max_tokens` |
| `openai` / `OpenAIDiagramProvider` | `api.openai.com/v1/responses` | `response.output_text.delta` only; completed/incomplete/failed/refusal/tool outcomes; final text snapshots ignored; `max_output_tokens`, `store:false` |
| `gemini` / `GeminiDiagramProvider` | `generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` | Candidate zero answer parts only, thought parts/signatures/tools ignored, finish/safety/usage normalized; `maxOutputTokens` |
| `anthropic` / `AnthropicDiagramProvider` | `api.anthropic.com/v1/messages`, API version `2023-06-01` | Text content-block deltas only, thinking/tool payloads ignored, cumulative message usage, validated stop reason plus `message_stop`; `max_tokens` |
| `mock` / `MockDiagramProvider` | Local deterministic fixture | Identical normalized events, no keys or network; ignores the real-provider token limit |

Only the adapters/common framing code know provider payload fields. Routes, prompt building and operation parsing contain no provider-specific response handling. Tools/search/continuation are disabled; no single-document JSON response mode is used because it would conflict with incremental NDJSON. Groq Compound and OpenRouter `:online` hosted-tool variants are rejected by preflight.

Configured control allowlists:

- All real profiles: `temperature` only with verified `temperature_support`, finite/in-range value; unsupported controls fail rather than disappear.
- Groq: declared `reasoning_effort`, `reasoning_format: hidden|parsed` or `include_reasoning:false`. Output-mode options are mutually exclusive; enabled reasoning effort requires a declared safe output-mode capability. If the profile declares format support without selecting a value, the adapter defaults to hidden; include-flag-only profiles default to false. This avoids assuming GPT-OSS accepts Qwen's format parameter. Leading inline markup is rejected before any content reaches the operation parser. Separate reasoning fields are always ignored.
- OpenAI/OpenRouter: declared `reasoning_effort`, mapped to native `reasoning.effort`. Model-specific supported effort values still require a verified profile. OpenRouter also sets `exclude:true` for that configured reasoning output and permits only `provider.order`, `allow_fallbacks:false`, `require_parameters:true` routing options.
- Gemini: declared `thinking_budget` or `thinking_level` (mutually exclusive); maps to native `thinkingConfig` with thoughts excluded. Levels use the REST enum casing. These controls are not sent to models that lack the declared support.
- Anthropic: declared extended `thinking_budget`, minimum 1024 and below max output; incompatible temperature controls are rejected.

Real profiles require an exact non-placeholder model, enabled ID, nonempty credential environment value and `capabilities.verified:true`, plus compatible token field/options/limits. The verified flag is an operator assertion about the model/configuration, not a claim that implementation tests contacted that model. Disabled profiles do not need keys. Settings/key references are pinned until restart; no client may submit raw models/options/base URLs. Real model IDs remain account-configured, not guessed defaults.

Input budget policy is explicit and conservative: UTF-8 bytes of system/user text plus a 1024-token envelope reserve plus requested output must fit the declared context limit. This is an admission policy, not an exact tokenizer or billing count. The operator must verify model context/output limits. Reasoning tokens may consume the provider's output budget. No scene/text is silently truncated; budget failure preserves the caller's unsent transcript for B3/UI recovery.

`Finished` gained optional `effective_model`/`effective_provider` metadata with backwards-compatible defaults; IDs/metadata are bounded strings, not raw provider objects. Drawing operations/wire schemas were unchanged. Usage merges by replacing known cumulative fields, retaining unknowns as null, never summing snapshots. Cache/reasoning counts remain diagnostics.

## Timeouts, errors and retries

Connection/write/pool timeouts use `connect_timeout_seconds`. The service separately enforces time to first answer-text delta, idle answer-text time and total deadline using a local monotonic clock. Usage, comments and reasoning-only frames do not reset answer progress. First valid operation time is tracked separately. Downstream stalls count against the bounded request lifetime.

Normalized errors cover authentication/permission/model/unsupported parameter, rate/quota/context, provider timeout/unavailability, stream interruption, blocked content, output limit and invalid output. Task cancellation is propagated for B3 to represent as cancelled. Retry-after and upstream request IDs are retained when available. No retry, fallback, repair call or automatic continuation occurs, even after a retryable failure. Every failure preserves already yielded operations; unfinished continuation needs a fresh request/snapshot/ID.

## Files and dependencies

- New `backend/app/diagram/{__init__,interfaces,events,capabilities,context,parser,registry,service}.py`.
- New separate `backend/app/diagram/providers/{mock,groq,openrouter,openai,gemini,anthropic}.py` plus package initializers and narrow `common/{http,sse,chat}.py` helpers.
- New component tests `test_generation.py`, `test_providers.py`, `test_options.py`, `test_live.py` under `backend/app/diagram/`.
- New `backend/app/prompts/{__init__,diagram}.py`, `backend/scripts/demo_diagram.py`.
- Shared/composition changes: `backend/app/contracts/interfaces.py`, `backend/app/main.py`, `backend/app/config/capabilities.py`, foundation stage assertions, example settings, pyproject/lock, CI, README and this handoff.
- HTTPX moved from a development-only dependency to an exact runtime dependency. Vosk remains optional. No SDK/key-dependent import is required to start mock mode.
- No frontend source changes in B2. B0/B1 contracts and standalone behavior remain intact; nine shared JSON Schemas and the frontend fixture snapshot still pass drift checks.

## Commands and actual results

Local Windows/Python 3.10.11, uv 0.13.7. API payload mappings were checked against official docs listed below. No paid/provider API calls were made.

- `uv run --project backend --extra speech pytest -q -rs`: **207 passed, 5 skipped**. Both installed real Vosk silence tests still passed. Five credentialed LLM tests were deliberately skipped individually: Groq, OpenRouter, OpenAI, Gemini, Anthropic.
- Base-only `uv sync --project backend --locked`, then `pytest -q -rs`: **205 passed, 7 skipped**. The additional two skips were real Vosk tests while its optional dependency was intentionally absent. The speech extra was restored afterward.
- B2 itself: 153 passing component tests plus five opt-in credentialed test definitions. Synthetic cases include arbitrary text/network boundaries and Unicode; correct usage/unknown fields; first operation before provider completion through all five adapters; stop/length/block/tool/unknown outcomes; explicit refusal/reasoning isolation; duplicate OpenRouter finish metadata; no duplicated OpenAI final snapshots; auth/permission/model/rate/quota/context errors; malformed upstream SSE versus invalid model NDJSON; idle/first-answer timeout; request cancellation and shared-client reuse; limits/protected edits/pending references/configuration preflight.
- `ruff check backend`, `ruff format --check backend`: passed.
- `python backend/scripts/export_protocol.py --check --frontend-root ../rendering`: passed (nine schemas plus fixture snapshot).
- Local mock demo: default/delayed and fragmented modes yielded six operations and completed with zero warnings. Invalid mode retained six valid operations and completed with one warning. Error mode yielded its first section, reported `stream_interrupted` and intentionally exited 1.
- Frontend `npm run typecheck`, `npm test -- --reporter=dot`, `npm run build`: passed; **248 frontend tests passed**. Production build retains its existing bundle-size advisory.

Existing Starlette/httpx test-client deprecation notice remains informational. Browser/e2e/deployment and credentialed provider smoke tests were not run in B2; earlier B1 browser results are historical, not re-labelled new B2 results. No latency, cost, quality or live provider availability benchmark is claimed.

Credentialed tests require `WHITEBOARD_LIVE_LLM_TESTS=1` and an enabled, exact-model, credentialed, verified profile for each provider. Ordinary CI explicitly sets the flag to 0 and makes no provider requests. Optional tests record exact provider/model IDs, operation count and first-operation timing when actually run. Synthetic conformance is not proof of API account access or model output quality.

## Demonstration and next steps

Success: `uv run --project backend python backend/scripts/demo_diagram.py --fixture delayed`. It streams compact validated operations object by object and a local completion record. It is a local diagnostic, not the B3 HTTP envelope. Use `--text 'New topic: the server queries the database'` to exercise a new section, or irrelevant speech for zero operations.

Failure: `uv run --project backend python backend/scripts/demo_diagram.py --fixture error`. The first operation remains visible in stdout, followed by a safe failed result and exit 1. A complete request missing edge protection or exceeding the context/token budgets is rejected before any provider connection. An enabled real profile with missing credentials, placeholder model or incompatible options is unavailable, with no silent mock fallback.

Start `python -m app` through uv to inspect B2 component capabilities. The public generation/session endpoints deliberately still return 501: proceed with B3 only when requested. B3 should consume these domain results, persist and sequence wire events, pin session/request configuration and connect the existing typed frontend transport. B4 should expand conformance/real-server/browser/deployment coverage and run explicitly credentialed model smoke/quality checks. B0 then performs final integration and release-gate review.

## Official references used

- [Groq Chat API](https://console.groq.com/docs/api-reference) and [reasoning output modes](https://console.groq.com/docs/reasoning).
- [OpenRouter streaming](https://openrouter.ai/docs/api/reference/streaming) and [Chat Completions API](https://openrouter.ai/docs/api-reference/chat-completion).
- [OpenAI Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses) and [streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events), reviewed with the OpenAI Docs skill.
- [Gemini GenerateContent API](https://ai.google.dev/api/generate-content), including REST thinking configuration.
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
