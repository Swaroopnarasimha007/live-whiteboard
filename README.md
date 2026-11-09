# AI Whiteboard

AI Whiteboard turns spoken explanations into editable diagrams. Hold to talk,
then release to draw. You can also add and edit shapes manually.

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

Install Git, then clone the repository. The `frontend/` and `backend/` folders
are at the repository root.

```sh
git clone https://github.com/Swaroopnarasimha007/live-whiteboard.git
cd live-whiteboard
cp .env.example .env
```

In PowerShell, use `Copy-Item .env.example .env`. Edit `.env`:

```dotenv
MODE=groq
API_KEY=your-groq-api-key
```

Use a valid Groq key for the default setup, or [try the mock demo](#mock-demo-without-keys-or-model-downloads).

### Run with Docker

Install Docker Desktop (Linux containers on Windows), or Docker Engine with the
Compose plugin on Linux. From the repository root, run:

```sh
docker compose up --build -d
```

On first startup, `model-init` downloads Whisper Small into a persistent Docker
volume. The backend waits for that step to succeed. If startup stalls or fails,
check `docker compose logs model-init backend`. Later starts reuse the model.

Open [the whiteboard](http://localhost:5173) once the services are ready. Select
**Start session**, allow microphone access when prompted, and use **Hold to talk**.

```sh
docker compose ps
docker compose down
```

After changing settings or `.env`, run `docker compose up -d --force-recreate`.
After changing source code, run `docker compose up --build -d`.
`docker compose down -v` also deletes downloaded models. Browser autosave is
independent of Docker. Backend readiness: http://localhost:8000/health/ready.

### Run without Docker

Install **Python 3.10+**, **Node.js 22** (22.17.1 or newer within the 22 series),
and **npm 10**. Configure `.env` as above. Use separate terminals for both servers.

#### Backend on Windows (PowerShell)

From the repository root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[speech]"
python -m app
```

If PowerShell blocks activation, run the virtual environment interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[speech]"
.\.venv\Scripts\python.exe -m app
```

#### Backend on macOS or Linux

From the repository root:

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[speech]"
python -m app
```

#### Locked backend dependencies (optional)

As an alternative to the pip setup on either platform, install `uv` and run from `backend/`:

```sh
uv sync --frozen --no-dev --extra speech
uv run --no-sync python -m app
```

On either platform, starting the backend downloads the configured Whisper model
if it is missing. If the download fails, the backend still starts and reports
speech as unavailable. To download it separately, run `python -m scripts.models.ensure`
from `backend/` with the virtual environment active, or prefix the command with
`uv run --no-sync` if you used uv.

#### Frontend in a second terminal

From the repository root:

```sh
cd frontend
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite proxies API and microphone WebSocket traffic
to 127.0.0.1:8000. Keep both ports available. Stop either server with Ctrl+C.
If you change the backend port, update the Vite/Nginx/Compose routing too.
The backend uses one worker because session state lives in memory.

### Mock demo without keys or model downloads

For the fastest preview, run just the [frontend](#frontend-in-a-second-terminal)
and select **Start demo** on the empty board. This uses built-in fixtures and
works without a backend, microphone, API key, or model download.

To try the full client and server in mock mode, set `MODE=mock` and `API_KEY=`
in `.env`, set `speech_profile: mock` in `backend/config/settings.yaml`, and
start both services. Use the backend input mode for this setup.

For a local mock backend, `python -m pip install -e .` is enough; speech extras
are only needed for real transcription.

### Configure the backend

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

### Other speech models

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
