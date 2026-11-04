"""Install the selected Whisper model once; used by Docker's initialization service."""

from app.config import load_settings
from app.speech.models import model_valid

from .install import MODELS, install


def ensure_models(settings=None):
    settings = settings or load_settings()
    name = settings.transcription.default_profile
    profile = settings.transcription.profiles[name]
    if profile.provider == "mock":
        print("Mock speech selected; no model download needed.")
        return
    target = settings.model_path(name)
    if model_valid(target):
        print(f"Speech model already installed: {name}")
        return
    if name not in MODELS or target.name != MODELS[name].split("/")[-1]:
        raise ValueError("Custom speech models must be installed at the configured path.")
    print(f"Installing {name}; first startup needs internet and may take a few minutes.")
    install(name, target.parent)


if __name__ == "__main__":
    ensure_models()
