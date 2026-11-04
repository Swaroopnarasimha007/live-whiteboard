import asyncio
import importlib.util
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .errors import SpeechError


def model_valid(path: Path) -> bool:
    return all((path / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json"))


def whisper_installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def load_whisper_model(path: Path, *, device="cpu", compute_type="int8"):
    try:
        from threading import Lock

        from faster_whisper import WhisperModel

        return WhisperResource(
            WhisperModel(
                str(path),
                device=device,
                compute_type=compute_type,
                local_files_only=True,
                num_workers=1,
            ),
            Lock(),
        )
    except Exception:  # noqa: BLE001 -- Native errors must not expose local paths.
        raise SpeechError(
            "model_unavailable", "Whisper could not load. Install the speech extra and model."
        ) from None


@dataclass
class WhisperResource:
    model: object
    lock: object


@dataclass
class Entry:
    task: asyncio.Task
    users: int = 0


class ModelCache:
    """Bounded lazy cache. Pending loads occupy slots and are deduplicated too."""

    def __init__(self, maximum: int, loader: Callable = load_whisper_model):
        self.maximum, self.loader = maximum, loader
        self.entries: OrderedDict[Path, Entry] = OrderedDict()
        self.lock = asyncio.Lock()
        self.closed = False

    async def acquire(self, path: Path):
        path = path.resolve()
        async with self.lock:
            if self.closed:
                raise SpeechError("closed", "Speech registry is closed.")
            if path not in self.entries:
                if len(self.entries) >= self.maximum:
                    victim = next(
                        (key for key, e in self.entries.items() if e.users == 0 and e.task.done()),
                        None,
                    )
                    if victim is None:
                        raise SpeechError(
                            "overloaded",
                            "All speech model slots are in use. Stop another capture and retry.",
                        )
                    del self.entries[victim]
                task = asyncio.create_task(asyncio.to_thread(self.loader, path))
                # Retrieve failed orphan load exceptions after a caller cancels.
                task.add_done_callback(
                    lambda task: task.exception() if not task.cancelled() else None
                )
                self.entries[path] = Entry(task)
            entry = self.entries[path]
            entry.users += 1
            self.entries.move_to_end(path)
        try:
            return await asyncio.shield(entry.task)
        except BaseException:
            await self.release(path)
            raise

    async def release(self, path: Path):
        async with self.lock:
            entry = self.entries.get(path.resolve())
            if entry is not None:
                entry.users -= 1
                if (
                    entry.users == 0
                    and entry.task.done()
                    and (entry.task.cancelled() or entry.task.exception() is not None)
                ):
                    del self.entries[path.resolve()]

    async def aclose(self):
        async with self.lock:
            self.closed = True
            tasks = [entry.task for entry in self.entries.values()]
        await asyncio.gather(*tasks, return_exceptions=True)
        self.entries.clear()
