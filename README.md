# AI Whiteboard

The application lives in `ai_whiteboard/`, with a React frontend and Python backend.
All commands below start here unless noted otherwise.

**Defaults:** Groq `openai/gpt-oss-120b` for diagrams and local **Whisper Small** for speech.

Skip to the section you’re interested in:

1. [Architecture diagram](#architecture)
2. [Demo video](#demo-video)
3. [Run it yourself](#run-it-yourself)

## Architecture

![AI Whiteboard architecture: React and FastAPI exchange PCM audio and transcripts over WebSocket, send generation requests as JSON, and stream diagram events as NDJSON. Whisper runs locally, Groq generates diagram operations, and the browser renders and saves the drawing.](docs/architecture.svg)

## Demo video

Demo video coming soon.

## Run it yourself

### Run with Docker

Install Git and Docker Desktop (Linux containers on Windows), or Docker Engine
with the Compose plugin on Linux.

```sh
git clone --branch release/v2 https://github.com/Swaroopnarasimha007/live-whiteboard.git
cd live-whiteboard/ai_whiteboard
cp .env.example .env
```

In PowerShell, use `Copy-Item .env.example .env`. Edit `.env`:

```dotenv
MODE=groq
API_KEY=your-groq-api-key
```

Then start both servers:

```sh
docker compose up --build -d
docker compose logs -f
```

Open **http://localhost:5173** once the backend is ready. On first startup,
`model-init` downloads Whisper Small into a persistent Docker volume. This needs
internet and disk space and may take a few minutes. Later starts reuse the model.
Allow microphone access and use **Hold to talk**; release to draw. Groq requires
a valid key and may charge for requests.

```sh
docker compose ps
docker compose down
```

After changing settings or `.env`, run `docker compose up -d --force-recreate`.
After changing source code, run `docker compose up --build -d`.
`docker compose down -v` also deletes downloaded models. Browser autosave is
independent of Docker. Backend readiness: http://localhost:8000/health/ready.

## Simple settings first

Both files load automatically:

- **`backend/config/settings.yaml`** — the three everyday choices below.
- **`backend/config/settings.advanced.yaml`** — provider profiles, capabilities,
  server origins, timeouts, audio limits and other tuning. Most users can leave it unchanged.

```yaml
mode: groq
model: openai/gpt-oss-120b
speech_profile: whisper-small
```

`mode` accepts `groq`, `claude` (or `anthropic`), `openai`, `gemini`, `openrouter`,
or `mock`. The starter `model` applies to the selected real provider. When changing
providers, use a compatible model and matching advanced capabilities.
`speech_profile` accepts `whisper-small`, `whisper-medium`, or `mock`.

`.env` contains **only MODE and API_KEY**. Use a key issued by the selected provider.
It is ignored by Git and excluded from image builds; the frontend never receives
the key. Only the empty-key `.env.example` is committed.

A nonempty MODE overrides the starter `mode`. Set `MODE=` or remove that line to
let the starter file choose the provider. Speech selection is independent of MODE.
Restart after changing configuration.

Precedence: built-in defaults → advanced YAML → starter YAML → advanced
`WHITEBOARD__...` process environment variables → nonempty MODE. Process environment
variables take precedence over `.env`. API_KEY is resolved at runtime. Existing
full-format YAML remains supported through `WHITEBOARD_CONFIG`; relative paths
resolve from `backend`, with an advanced sibling loaded first when present.
These advanced environment variables do not belong in the two-variable `.env`.

## Run without Docker

Install **Python 3.10+**, **Node.js 22** (22.17.1 or newer within the 22 series),
and **npm 10**. Configure `.env` as above. Use separate terminals for both servers.

### Backend — Windows PowerShell

From `ai_whiteboard`:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[speech]"
python -m app
```

On first startup, the backend automatically downloads the selected Whisper model
if it is missing. This needs internet access and may take a few minutes; later
starts reuse it. If download fails, the board backend still starts and reports
speech as unavailable until the model can be installed. Run
`python -m scripts.models.ensure` first only if you want to download the model
before launching the server.

If PowerShell blocks activation, run the virtual environment interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[speech]"
.\.venv\Scripts\python.exe -m app
```

### Backend — macOS / Linux

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[speech]"
python -m app
```

The initializer downloads only when the selected default model is missing.
For exact locked dependencies, install `uv`, then run from `backend`:

```sh
uv sync --frozen --no-dev --extra speech
uv run --no-sync python -m app
```

The first `python -m app` startup downloads the configured Whisper model when it
is missing. If the download cannot complete, the board still starts with speech
unavailable. To pre-download it, run `python -m scripts.models.ensure` (or
`uv run --no-sync python -m scripts.models.ensure`) before starting the server.

### Frontend — second terminal

From `ai_whiteboard`:

```sh
cd frontend
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite proxies API and microphone WebSocket traffic
to 127.0.0.1:8000. Keep both ports available. Stop either server with Ctrl+C.
If you change the backend port, update the Vite/Nginx/Compose routing too.
The backend uses one worker because session state lives in memory.

## Mock demo without keys or model downloads

Set `.env` to `MODE=mock` and `API_KEY=`. Set `speech_profile: mock` in
`backend/config/settings.yaml`, then start normally. No model is downloaded.
The UI also has a built-in **Start demo**. A backend configured for Whisper
tries to install the model at startup; if that is unavailable, the backend still
starts and reports speech as unavailable until setup succeeds.

For a local mock backend, `python -m pip install -e .` is enough; speech extras
are only needed for real transcription.

## Other speech models

Change `speech_profile` to `whisper-medium`, then run the initializer again
locally or recreate the Docker services. To install a non-default profile
explicitly, run from `backend`:

```sh
python -m scripts.models.install whisper-small
python -m scripts.models.install whisper-medium
```

For Docker:

```sh
docker compose run --rm model-init python -m scripts.models.install whisper-medium
```

Custom speech model paths require manually installing a compatible model there.
Use localhost for microphone access; remote hosting requires HTTPS and explicit
allowed origins.

## Development checks

From `backend`:

```sh
uv sync --frozen --group dev
uv run ruff check app tests scripts
uv run pytest -q
```

Tests explicitly use mock services and need no API keys or downloads.
From `frontend`:

```sh
npm ci
npm run build
npm test
npm run test:backend-contracts
```

Browser tests additionally require `npx playwright install chromium`.
Historical notes under `docs/` refer to earlier layouts; follow this README for current paths.
