"""B4 shared normalized contract matrix; reuse B2 provider-shaped framing fixtures."""

import asyncio

import pytest

from app.contracts.interfaces import Finished, ProviderError, TextDelta, Usage
from app.diagram.providers.common.http import merge_usage
from app.diagram.test_providers import NAMES, TEXT, adapter, frames, llm


@pytest.mark.parametrize("provider", NAMES)
@pytest.mark.parametrize("scenario", ["stop", "length", "refusal", "eof", "error", "cancel"])
def test_synthetic_conformance_matrix(provider, scenario):
    async def run():
        chunks = frames(
            provider,
            texts=(TEXT,),
            terminal=scenario not in ("eof", "cancel"),
            reason="length" if scenario == "length" else "stop",
            refusal=scenario == "refusal",
        )
        if scenario == "cancel":
            chunks += [30.0]
        async with adapter(provider, chunks, status=429 if scenario == "error" else 200) as (
            instance,
            streams,
            _,
            client,
        ):
            events = []
            iterator = instance.stream(llm())
            try:
                if scenario == "cancel":
                    while not isinstance(await anext(iterator), TextDelta):
                        pass
                    task = asyncio.create_task(anext(iterator))
                    await asyncio.sleep(0)
                    task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await task
                elif scenario in ("eof", "error"):
                    with pytest.raises(ProviderError) as caught:
                        async for event in iterator:
                            events.append(event)
                    assert caught.value.code == (
                        "stream_interrupted" if scenario == "eof" else "rate_limited"
                    )
                else:
                    events = [event async for event in iterator]
                    assert sum(isinstance(event, Finished) for event in events) == 1
                    assert (
                        events[-1].reason
                        == {"stop": "stop", "length": "length", "refusal": "blocked"}[scenario]
                    )
                    text = "".join(event.text for event in events if isinstance(event, TextDelta))
                    assert text == ("" if scenario == "refusal" else TEXT)
                    usage = Usage(None, None)
                    for event in events:
                        if isinstance(event, Usage):
                            usage = merge_usage(usage, event)
                    assert usage.cached_input_tokens is None
                    if scenario != "refusal":
                        assert usage.input_tokens == 10 and usage.output_tokens == 2
            finally:
                await iterator.aclose()
            assert streams[0].closed and not client.is_closed

    asyncio.run(run())
