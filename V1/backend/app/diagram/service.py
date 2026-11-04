import asyncio
import json
import time
from dataclasses import dataclass

from app.contracts.interfaces import Finished, LLMRequest, ProviderError, TextDelta, Usage
from app.diagnostics import diagnostic
from app.prompts import build_prompt

from .context import enforce_token_budget, validate_context
from .events import CompletedResult, FailedResult, GenerationState, OperationResult
from .parser import OperationParser
from .providers.common.http import close_iterator, merge_usage


@dataclass(frozen=True)
class PreparedGeneration:
    request_json: str
    profile: str
    llm_request: LLMRequest
    configuration_fingerprint: str


class GenerationService:
    def __init__(self, registry):
        self.registry = registry
        self.settings = registry.settings

    def prepare(self, request, profile=None):
        snapshot = validate_context(request, self.settings)
        name = self.registry.select_profile(profile)
        config = self.settings.diagram.profiles[name]
        instructions, input_text = build_prompt(snapshot)
        llm = LLMRequest(
            snapshot.requestId,
            config.model,
            instructions,
            input_text,
            self.settings.diagram.max_output_tokens,
            config.options.get("temperature"),
        )
        enforce_token_budget(llm, config)
        diagnostic(
            "generation.prepared",
            request_id=snapshot.requestId,
            session_epoch=snapshot.sessionEpoch,
            base_revision=snapshot.baseRevision,
            profile=name,
            provider=config.provider,
            model=config.model,
            nodes=len(snapshot.board.nodes),
            edges=len(snapshot.board.edges),
            transcript_characters=len(snapshot.transcript.text),
        )
        return PreparedGeneration(
            snapshot.model_dump_json(), name, llm, self.settings.fingerprint()
        )

    async def generate(self, prepared: PreparedGeneration, *, state: GenerationState | None = None):
        state = state if state is not None else GenerationState()
        config = self.settings.diagram.profiles[prepared.profile]
        state.profile, state.provider, state.model = prepared.profile, config.provider, config.model
        state.configuration_fingerprint = prepared.configuration_fingerprint
        request = validate_context(json.loads(prepared.request_json), self.settings)
        parser = OperationParser(request, self.settings.diagram)
        parser.stop_on_invalid_streak = not config.capabilities.structured_output
        iterator = None
        started = time.monotonic()
        text_at = None
        terminal = None
        failure = None
        cancelled = False
        diagnostic(
            "generation.provider_start",
            request_id=request.requestId,
            profile=prepared.profile,
            provider=config.provider,
            model=config.model,
        )
        try:
            if prepared.configuration_fingerprint != self.settings.fingerprint():
                raise ProviderError(
                    "model_unavailable",
                    "Prepared request configuration no longer matches this registry.",
                )
            iterator = self.registry.get(prepared.profile).stream(prepared.llm_request).__aiter__()
            while True:
                now = time.monotonic()
                text_deadline = (
                    (started + self.settings.diagram.first_text_timeout_seconds)
                    if text_at is None
                    else (text_at + self.settings.diagram.idle_text_timeout_seconds)
                )
                remaining = (
                    min(started + self.settings.diagram.provider_timeout_seconds, text_deadline)
                    - now
                )
                if remaining <= 0:
                    raise ProviderError(
                        "provider_timeout",
                        "Provider answer-text or total deadline was exceeded.",
                        retryable=True,
                    )
                try:
                    event = await asyncio.wait_for(anext(iterator), timeout=remaining)
                except StopAsyncIteration:
                    if terminal is None:
                        raise ProviderError(
                            "stream_interrupted",
                            "Provider ended without a validated terminal event.",
                        ) from None
                    break
                except asyncio.TimeoutError:
                    raise ProviderError(
                        "provider_timeout",
                        "Provider answer-text or total deadline was exceeded.",
                        retryable=True,
                    ) from None
                if isinstance(event, TextDelta):
                    if terminal is not None:
                        raise ProviderError(
                            "invalid_output", "Provider emitted text after its terminal event."
                        )
                    if event.text:
                        text_at = time.monotonic()
                        if state.first_text_seconds is None:
                            state.first_text_seconds = text_at - started
                            diagnostic(
                                "generation.first_text",
                                request_id=request.requestId,
                                elapsed_ms=round(state.first_text_seconds * 1000, 2),
                            )
                        for result in parser.feed(event.text):
                            if isinstance(result, OperationResult):
                                state.operation_count += 1
                                if state.first_operation_seconds is None:
                                    state.first_operation_seconds = time.monotonic() - started
                            else:
                                state.warning_count += 1
                            yield result
                elif isinstance(event, Usage):
                    state.usage = merge_usage(state.usage, event)
                elif isinstance(event, Finished):
                    if terminal is not None:
                        raise ProviderError(
                            "invalid_output", "Provider emitted duplicate terminal events."
                        )
                    terminal = event
                    state.upstream_request_id = event.provider_request_id
                    state.effective_provider, state.effective_model = (
                        event.effective_provider,
                        event.effective_model,
                    )
                else:
                    raise ProviderError(
                        "invalid_output", "Provider emitted an unknown normalized event."
                    )
            if terminal.reason != "stop":
                code = {
                    "length": "output_limit",
                    "blocked": "content_blocked",
                    "tool_call": "invalid_output",
                    "unknown": "stream_interrupted",
                }[terminal.reason]
                raise ProviderError(
                    code, "Provider ended without a complete plain-text diagram response."
                )
            for result in parser.finish():
                if isinstance(result, OperationResult):
                    state.operation_count += 1
                    if state.first_operation_seconds is None:
                        state.first_operation_seconds = time.monotonic() - started
                else:
                    state.warning_count += 1
                yield result
        except asyncio.CancelledError:
            cancelled = True
            raise
        except ProviderError as exc:
            diagnostic(
                "generation.provider_error",
                warning=True,
                request_id=request.requestId,
                code=exc.code,
                retryable=exc.retryable,
                upstream_request_id=exc.upstream_request_id,
            )
            failure = FailedResult(exc.code, exc.message, exc.retryable, exc.retry_after)
            state.upstream_request_id = exc.upstream_request_id or state.upstream_request_id
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
            failure = FailedResult("invalid_output", "Generation received invalid provider data.")
        finally:
            if iterator is not None:
                try:
                    await close_iterator(iterator)
                    state.local_stream_closed = True
                except (Exception, asyncio.CancelledError):  # noqa: BLE001 -- Cleanup must not mask a partial generation/cancellation.
                    if not cancelled and failure is None:
                        failure = FailedResult(
                            "stream_interrupted", "Provider stream cleanup did not complete."
                        )
            state.elapsed_seconds = time.monotonic() - started
            diagnostic(
                "generation.provider_end",
                warning=bool(failure),
                request_id=request.requestId,
                outcome="cancelled" if cancelled else failure.code if failure else "completed",
                operations=state.operation_count,
                warnings=state.warning_count,
                elapsed_ms=round(state.elapsed_seconds * 1000, 2),
                local_stream_closed=state.local_stream_closed,
                upstream_request_id=state.upstream_request_id,
                finish_reason=terminal.reason if terminal else None,
                model=config.model,
                structured_output=config.capabilities.structured_output,
                text_delivery="buffered_response"
                if config.capabilities.structured_output
                else "incremental_text",
                input_tokens=state.usage.input_tokens,
                output_tokens=state.usage.output_tokens,
                cached_input_tokens=state.usage.cached_input_tokens,
                reasoning_tokens=state.usage.reasoning_tokens,
                first_operation_ms=round(state.first_operation_seconds * 1000, 2)
                if state.first_operation_seconds is not None
                else None,
                unresolved_references=len(parser.table.pending),
            )
        yield failure if failure else CompletedResult(state.operation_count, state.warning_count)
