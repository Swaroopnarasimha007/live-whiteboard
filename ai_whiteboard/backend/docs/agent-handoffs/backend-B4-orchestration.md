# B4 coordinated verification — 2026-11-03

The user requested B4 implementation in one chat and an independent review/fix pass in a second chat, with this original chat coordinating. Both worked in the existing shared checkouts. File ownership separated B4 integration/benchmark/deployment assets from runtime components and their regression tests. Production findings from B4 were relayed to the review chat; the original chat ran the combined gate after changes settled.

## Final result

B4 implementation and the justified review fixes are delivered. See [B4 scope, scenario map and measurements](backend-B4.md), [runtime findings and fixes](backend-review-fixes.md), and the [runbook](../backend-B4-runbook.md).

| Final check | Result |
| --- | --- |
| Full backend suite | 261 passed; five paid-provider and two optional WAV tests explicitly skipped |
| Optional WAV checks, both real Vosk profiles | 2 passed with the speech extra and installed models |
| Backend/benchmark/deployment Ruff lint and formatting | Passed; 78 Python files formatted |
| Generated schemas and sibling fixture drift | 9 schemas checked; passed |
| Frontend `npm run check` | Typecheck, lint, formatting, 274 unit tests and production build passed |
| Explicit canonical Python/TypeScript contract gate | 4 passed |
| Existing browser acceptance | 64 passed: default 18; scene 1; layout 1; board 11; editor 12; stream 3; session 7; UI 9; Firefox/WebKit 2 |
| Final complete B4 browser gate | 10 passed in 55.0 seconds, including both real Vosk profiles, actual backend process restart, malformed EOF, stale edits, replay/reset, manual context and actual Konva draws |
| Default live-provider smoke report | Five explicit skips; no paid calls |

The full default browser suite initially exposed a fixture gate race. The review chat reproduced it and changed the stale-edit test to wait until its asynchronous request gate exists before editing/releasing. All 18 cases passed afterward. This correction preserves the stale-update rejection assertion and does not increase its timeout.

An intermediate complete B4 browser run passed eight cases but correctly rejected both supposed real-speech cases: capabilities reported `provider_not_installed`, and the actual server profile was mock. The cause was an ordinary uv command resynchronizing the environment without the optional speech extra after successful model checks. Restoring `uv sync --project backend --locked --extra speech` fixed the environment. Speech tests now verify the option is enabled and the selected profile is committed before Start, then independently assert the server-issued profile. The final 10-case run passed with those stronger assertions. No mock result is counted as real recognition.

## Preserved verification artifacts

The final B4 run used `C:/Work/rendering/.cache/orchestrator-b4`, separate from ordinary Playwright output. Its reports were copied before any cleanup:

- [US real-speech browser verification](../../benchmarks/backend/verified-speech-vosk-us-small.json): capture start to first-node actual Konva draw, 4416.4 ms in this one synthetic trial.
- [Indian real-speech browser verification](../../benchmarks/backend/verified-speech-vosk-india-small.json): the same span, 4314.3 ms in this one synthetic trial.
- [Final browser draw verification](../../benchmarks/backend/verified-browser-draw.json): operation receipt to actual Konva draw p95 23.7 ms, 30 operations.

These correctness-run samples supplement rather than replace B4's saved [Python baseline](../../benchmarks/backend/measured-windows.json) and [browser baseline](../../benchmarks/backend/measured-browser.json). Baseline draw p95 was 20.2 ms; timings vary by run and workload. Browser reports use only browser monotonic timestamps. Python reports use only Python monotonic timestamps. Neither physical-screen timing nor representative speech/remote-provider latency is inferred by combining them.

## Integrated fixes and coordination changes

The review chat fixed repeated task cancellation interrupting provider cleanup (including shutdown), stale HTTP errors clearing a newer identity, obsolete-session capacity leaks and profile/epoch replacement races, temporary reconnect errors losing the recoverable identity, and Stop/disconnect terminal-acknowledgement failures. Focused regressions reproduced these defects before the corresponding fixes. It also corrected the existing stale-edit test synchronization described above. Wire contracts and dependency versions were unchanged.

The orchestrator additionally excluded generated `.cache/` artifacts from frontend Git/Prettier inputs and made the unauthenticated nginx sample explicitly loopback-only at `127.0.0.1:8080`. These changes prevent isolated test evidence from polluting source checks and preserve the project's local-service default.

## Verification boundaries

Both Vosk profiles were exercised with identical production-resampled synthetic audio, not representative lectures or a physical microphone. No paid provider call, hosted CI run, actual nginx instance, public deployment, annotated natural speech-endpoint evaluation, or hours-long soak was performed. Local proxy streaming is tested; the nginx configuration and probe are supplied for deployment-specific validation. The existing large Vite chunk advisory and Starlette/httpx TestClient deprecation remain documented. Sessions remain bounded, in-memory and single-worker.

Downloaded weights and generated WAV binaries remain ignored. Reports contain synthetic transcript/technical measurements and no credentials. The speech extra is restored in the backend environment after the final run. Both implementation chats are left available for user follow-up; no worktree, commit, external message, or deployment was created.
