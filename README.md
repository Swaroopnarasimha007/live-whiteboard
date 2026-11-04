# AI Whiteboard

**[Open ai_whiteboard →](ai_whiteboard/)** · **[Setup and usage →](ai_whiteboard/README.md)**

The application lives in `ai_whiteboard/`, with `frontend` and `backend` folders.
The defaults on **release/v2** are **Groq GPT-OSS 120B** for diagrams and
**Whisper Small** for local speech transcription.

```sh
git clone --branch release/v2 https://github.com/Swaroopnarasimha007/live-whiteboard.git
cd live-whiteboard/ai_whiteboard
cp .env.example .env
# Add your Groq API key to .env.
docker compose up --build -d
```

In PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
Open **http://localhost:5173** once the backend is ready. The first startup
downloads Whisper Small; later starts reuse the model.

The `.env` has only `MODE` and `API_KEY`. Most users only need the key.
The [starter settings](ai_whiteboard/backend/config/settings.yaml) have three
choices: provider, model and speech profile. Provider details and limits are in
[advanced settings](ai_whiteboard/backend/config/settings.advanced.yaml).

For virtual environment setup and running both servers **without Docker**, see
the [application README](ai_whiteboard/README.md#run-without-docker).
