# Whiteboard backend

See the [application startup guide](../README.md) for Docker, Python virtual environments,
configuration, provider keys, and optional Whisper installation.

Run `python -m app` from this directory after installing the package.
The server automatically reads the starter `config/settings.yaml`, the detailed
`config/settings.advanced.yaml`, and `../.env`. Defaults are Groq GPT-OSS 120B
and Whisper Small. Run `python -m scripts.models.ensure` once before starting
to install the selected speech model; Docker does this automatically.
