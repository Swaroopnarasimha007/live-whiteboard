# Whiteboard backend

See the [application startup guide](../README.md) for Docker, Python virtual environments,
configuration, provider keys, and optional Whisper installation.

Run `python -m app` from this directory after installing the package.
The server automatically reads the starter `config/settings.yaml`, the detailed
`config/settings.advanced.yaml`, and `../.env`. Defaults are Groq GPT-OSS 120B
and Whisper Small. On first startup, the backend automatically downloads the
selected Whisper model if it is missing. This needs internet access and may take
a few minutes; later starts reuse the downloaded model. If download fails, the
board backend still starts and reports speech as unavailable. To pre-download
the model, run `python -m scripts.models.ensure` from this directory.
