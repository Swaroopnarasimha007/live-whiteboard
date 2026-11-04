# Live Whiteboard V1

React/Vite frontend and Python/FastAPI backend. Start in mock mode without an API
key or downloaded speech models. This package is intended for local use.

```text
V1/
  frontend/          React application and production Nginx proxy
  backend/           Python application, settings, tests and speech installer
  shared/            API protocol schemas
  .env.example       Two user settings: MODE and API_KEY
  compose.yaml       Builds and starts both services
```

## Clone and run with Docker

Install Git and Docker Desktop (enable Linux containers on Windows), or Docker
Engine with the Compose plugin on Linux. Git is already installed on the machine
where this package was prepared. Once this repository has been published:

```sh
git clone --branch develop <repository-url>
cd <repository-folder>/V1
docker compose up --build -d
```

Replace the angle-bracket placeholders with your repository URL and folder name.
No remote repository is configured by this package. The first build needs internet
access to install dependencies. No `.env` is required for the default mock demo.

Open **http://localhost:5173**. The backend is at http://localhost:8000;
http://localhost:8000/health/ready should return `ready`. In the UI, use **Mock demo**
for the deterministic demo. Live backend sessions use the selected diagram provider.
The default mock transcription emits fixture text, not a transcription of your voice.
Use the Whisper instructions below for real speech.

```sh
docker compose ps
docker compose logs -f
docker compose down
```

After editing `.env` or YAML, run `docker compose up -d --force-recreate`.
After changing application code, run `docker compose up --build -d`.
Model downloads persist in the `whisper-models` volume; `docker compose down -v`
also deletes those downloads. Board autosave is stored in the browser, not Docker.

## The two environment settings

Copy `.env.example` to `.env` in **V1**, beside `compose.yaml`:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

Only these two variables belong in `.env`:

```dotenv
MODE=mock
API_KEY=
```

| MODE | Diagram provider | Default model |
| --- | --- | --- |
| `mock` | Local deterministic fixture | `request-flow` |
| `groq` | Groq | `openai/gpt-oss-120b` |
| `claude` or `anthropic` | Anthropic | `claude-sonnet-5-5` |
| `openai` | OpenAI | `gpt-4.1-mini` |
| `gemini` | Google Gemini | `gemini-3.6-flash` |
| `openrouter` | OpenRouter | `openai/gpt-4.1-mini` |

For example, set `MODE=groq` and `API_KEY=your-groq-key`, then restart the
backend (or recreate the Docker services). Use a key issued by the selected
provider. Real providers require account access, network connectivity and may
charge for requests. Provider requests were not exercised with paid credentials
when preparing this package. Model IDs and capability defaults can be changed
in `backend/config/settings.yaml` if your account needs another model.

The local `.env` is ignored by Git and excluded from Docker image builds. The
frontend does not receive `API_KEY`. Commit `.env.example` with an empty key only.

## Use YAML instead

The backend automatically loads `backend/config/settings.yaml`. Set `MODE=` (empty)
in `.env`, or remove the MODE line/file, to use YAML provider selection. For example:

```yaml
diagram:
  active_profile: groq-default
  enabled_profiles:
    - groq-default
```

Keep `API_KEY` in `.env`; YAML profiles refer to its environment variable name
through `api_key_env: API_KEY`, so you never need to store a literal secret in YAML.
YAML also controls ports, origins, model IDs, timeouts and transcription profiles.

Settings precedence: application defaults, YAML, advanced `WHITEBOARD__...`
environment overrides, then nonempty MODE. A nonempty API_KEY selects the common
credential variable for the active provider. Process environment variables take
precedence over `.env`. `WHITEBOARD_CONFIG` can point to an alternate YAML file
(relative paths resolve from `backend`). These advanced variables do not need to
be added to the two-setting `.env`.

## Run without Docker

Install **Python 3.10+**, **Node.js 22** (22.17.1 or newer within the 22 series),
and **npm 10**. No global Python packages or global frontend packages are needed.
Start the two servers in separate terminals. Both use the same V1 `.env` and YAML
configuration as Docker. Stop either server with Ctrl+C.

### Windows PowerShell — backend

From the repository root:

```powershell
cd V1\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .
python -m app
```

If PowerShell prevents activation, run the virtual environment's interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m app
```

### macOS / Linux — backend

```sh
cd V1/backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
python -m app
```

For installs that exactly follow the checked-in Python lockfile, install `uv` and
run `uv sync --frozen --no-dev` from `backend`, then `uv run --no-sync python -m app`.

### Frontend — second terminal, all platforms

From the repository root:

```sh
cd V1/frontend
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite proxies API and WebSocket requests to
127.0.0.1:8000; no frontend `.env` or API URL editing is required. Keep ports
5173 and 8000 available. If you change the backend port in YAML, also update the
Vite proxy target (and Compose/Nginx ports if using Docker). Backend workers must
remain at one because session state lives in memory.

## Optional real microphone transcription (Whisper)

MODE controls diagram generation. Speech has a separate YAML profile so the
two-setting `.env` stays simple. Whisper runs locally on CPU by default; its model
download requires internet and disk space. Mock mode never downloads models.

Without Docker, activate the backend virtual environment and run from `backend`:

```sh
python -m pip install -e ".[speech]"
python -m scripts.models.install whisper-small
```

With Docker, while still using the default mock transcription:

```sh
docker compose run --rm backend python -m scripts.models.install whisper-small
```

Then change only `transcription.default_profile` to `whisper-small` in
`backend/config/settings.yaml`, and restart the backend (or recreate the Docker
services). Allow microphone access in the browser and use Hold to talk. Download
`whisper-medium` with the same command if you want to select that larger profile.
The Docker backend includes speech libraries; local mock/text use only needs `-e .`.
Use localhost for microphone access; hosting elsewhere requires HTTPS and explicit
origin configuration.

## Development checks

```sh
cd V1/backend
uv sync --frozen --group dev
uv run pytest -q
uv run ruff check app tests scripts
```

From `V1/frontend`:

```sh
npm run build
npm test
```

Frontend browser suites additionally need `npx playwright install chromium`.
Historical engineering notes in each app's `docs/` describe the original separate
checkouts; follow this README for the packaged V1 startup paths.

## References

Provider defaults were checked against the [Groq model catalog](https://console.groq.com/docs/models),
[Claude model catalog](https://platform.claude.com/docs/en/models/overview),
[Gemini model catalog](https://aistudio.google.com/docs/models), and
[GPT-4.1 mini reference](https://developers.openai.com/api/docs/models/gpt-4.1-mini).
Compose waits for backend readiness using Docker's documented
[service health dependency](https://docs.docker.com/compose/how-tos/startup-order/).
