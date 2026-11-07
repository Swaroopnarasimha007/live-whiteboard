"""Run a configured Whisper profile against the same consented 16 kHz mono PCM WAV."""

import argparse
import asyncio
import wave
from pathlib import Path

from app.config import load_settings
from app.contracts.audio import SpeechStreamConfig
from app.speech import SpeechRegistry


async def recognize(path: Path, profile: str):
    registry = SpeechRegistry(load_settings())
    try:
        with wave.open(str(path), "rb") as audio:
            if (
                audio.getnchannels(),
                audio.getsampwidth(),
                audio.getframerate(),
                audio.getcomptype(),
            ) != (1, 2, 16000, "NONE"):
                raise ValueError("Expected an uncompressed 16 kHz mono signed-16 PCM WAV")
            stream = await registry.open_stream(
                SpeechStreamConfig(streamId="smoke", sessionEpoch=1, profile=profile)
            )

            async def collect():
                return [
                    event async for event in stream.events() if getattr(event, "isFinal", False)
                ]

            consumer = asyncio.create_task(collect())
            while frame := audio.readframes(1600):
                await stream.push_audio(frame)
            await stream.finish()
            finals = await consumer
            # This explicit local command opts into printing its input's transcript.
            print(f"{profile}: {' '.join(event.text for event in finals)}")
    finally:
        await registry.aclose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument(
        "--profile", default="whisper-small", choices=["whisper-small", "whisper-medium"]
    )
    args = parser.parse_args()
    asyncio.run(recognize(args.wav, args.profile))


if __name__ == "__main__":
    main()
