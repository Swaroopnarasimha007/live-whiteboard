"""Install the selected Whisper model once during first application startup."""

from app.config import load_settings
from app.speech.models import model_valid

from .install import MODELS, ModelInstallDependencyError, install


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
    try:
        install(name, target.parent)
    except ModelInstallDependencyError:
        raise
    except Exception as error:
        raise RuntimeError(
            f"Could not install {name}. Check your internet connection and available disk space, "
            "then start the backend again."
        ) from error


if __name__ == "__main__":
    ensure_models()
