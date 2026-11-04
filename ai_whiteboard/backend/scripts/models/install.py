"""Install a pinned faster-whisper snapshot from the upstream model repository."""

import argparse
from pathlib import Path

from app.config import BACKEND_DIR
from app.speech.models import load_whisper_model, model_valid, whisper_installed

MODELS = {
    "whisper-small": "Systran/faster-whisper-small",
    "whisper-medium": "Systran/faster-whisper-medium",
}


class ModelInstallDependencyError(RuntimeError):
    """The optional speech dependencies needed for model setup are missing."""


def install(profile, destination):
    if not whisper_installed():
        raise ModelInstallDependencyError(
            "Whisper is selected, but its Python dependencies are missing. "
            'From the backend directory run: python -m pip install -e ".[speech]"'
        )
    from huggingface_hub import HfApi, snapshot_download

    model = MODELS[profile]
    revision = HfApi().model_info(model).sha
    target = destination / model.split("/")[-1]
    snapshot_download(
        model,
        revision=revision,
        local_dir=target,
        allow_patterns=["*.json", "*.bin", "*.txt", "README.md"],
    )
    if not model_valid(target):
        raise ValueError("Downloaded Whisper model is incomplete")
    (target / "MODEL_REVISION.txt").write_text(revision + "\n", encoding="utf-8")
    load_whisper_model(target)
    print(f"Installed and loaded {profile}; revision {revision}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=MODELS)
    parser.add_argument("--destination", type=Path, default=BACKEND_DIR / "models")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        target = args.destination / MODELS[args.profile].split("/")[-1]
        if not model_valid(target):
            parser.error("Model is not installed")
        load_whisper_model(target)
        print("Whisper model loaded successfully")
    else:
        install(args.profile, args.destination)


if __name__ == "__main__":
    main()
