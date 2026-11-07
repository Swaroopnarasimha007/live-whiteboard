# Whisper hold-to-talk handoff

Implemented in `C:\Work\backed` and `C:\Work\rendering`.

## User workflow

Whisper hold-to-talk is the default input mode. Hold the button with a mouse,
touch, Space, or Enter; release to finish and draw. Recording starts after the
connection and microphone are ready. Escape, focus loss, hidden tabs, and pointer
cancellation abort uncommitted audio. Stop also cancels generation; reset retires
the epoch. Earlier applied drawing survives capture cancellation.

Short holds are transcribed once on release. Long holds search for a 600 ms
speech pause after 8 seconds, with a 15-second maximum chunk. Settings live in
`transcription.endpointing`. The backend emits only final transcript events.
The frontend also rejects partials from entering backend-mode generation.
Final means immutable transcription output, not guaranteed recognition accuracy.

The old continuous microphone controls and local-preview input option are removed
from the product UI. Mock demo and isolated preview/PCM test utilities remain.
Vosk runtime code, model profiles, dependency, installer, and active config are
replaced. Old downloaded Vosk directories and historical measurements remain
unused; no user data/model directories were deleted.

## Models and readiness

`speech` installs faster-whisper, NumPy and their inference dependencies. Small is
installed at `backend/models/faster-whisper-small`; upstream snapshot revision is
recorded in `MODEL_REVISION.txt`. Default local and example config select Small,
CPU INT8, English. Medium is configured but intentionally not downloaded.

From `C:\Work\backed\backend`, using the prepared environment:

```powershell
.\.venv\Scripts\python.exe -m scripts.models.install whisper-small --verify
# Optional, larger download:
.\.venv\Scripts\python.exe -m scripts.models.install whisper-medium
```

The server loads the configured default before reporting ready. Runtime model
loading uses local files only. `device` and `compute_type` are explicit speech
profile settings; no automatic GPU switching occurs. Keep `--extra speech` on uv
commands to retain optional dependencies.

## Processing and bounds

One WebSocket stream represents one hold; its unique ID plus ordered chunk index
forms the transcript identity. Timestamps use captured sample counts, not network
arrival time. Overlap (500 ms by default) provides recognition context. Word
midpoints assign overlap ownership to the new chunk without text matching.
Forced cuts and word timestamps can still affect boundary accuracy.

Capture and inference run independently. Ordered worker threads keep native
inference off the event loop, with a shared model lock serializing inference.
Only finalized text enters the existing serial generation queue. Short release
flushes promptly; long-hold chunks can update the drawing while capture continues.

The server holds at most 60 seconds of queued PCM by default. Processed-sample
acknowledgements let the client automatically finish capture at 30 seconds of
unprocessed audio, leaving headroom to flush. This retains accepted audio rather
than launching retries or silently dropping frames. The UI reports the backlog.
Hard transport/protocol errors still terminate capture explicitly. Finish waits
up to 120 seconds; a disconnected browser cannot retain server-only audio.

Protocol v1 adds `progress` and `processed` server events. Both repositories must
be refreshed together. Progress distinguishes listening, transcription of earlier
audio, finalization, and diagram generation. Audio and transcript contents are
excluded from normal logs; chunk timings and character counts are recorded.

## Verification

Backend tests cover short release, forced long chunks, pause boundaries, silence,
timestamp ownership, cancellation, ordered workers, and real Small silence.
Frontend tests cover partial exclusion, release flushing, backlog finishing,
transport and scheduling. Chromium tests use real PCM/WebSocket/Whisper Small
and the mock diagram provider: short holds draw only after release, long holds
draw before release and finish the tail, and Escape/focus/pointer handling releases
capture. Production AudioWorklet coverage remains separate from injected PCM.

Synthetic Small smoke: “The browser sends a request to the server. The server
queries the database.” Local warm inference was approximately 2 seconds for this
5.585-second recording; this is not a human-speech accuracy or latency benchmark.
No paid LLM calls, GPU measurements, or Medium accuracy measurements were made.

Restart the backend with `WHITEBOARD_CONFIG` pointing at the local settings file,
restart/refresh the frontend, and select Whisper Small. Both ends changed protocol
handling, so stale browser tabs should be refreshed.
