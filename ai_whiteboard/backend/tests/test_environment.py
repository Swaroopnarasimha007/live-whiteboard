from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from app.config import BACKEND_DIR, ConfigurationError, load_settings
from app.diagram import DiagramRegistry
from app.main import create_app

CONFIG = BACKEND_DIR / "config/settings.yaml"


@pytest.mark.parametrize(
    "mode", ["mock", "groq", "claude", "anthropic", "openai", "gemini", "openrouter"]
)
def test_modes_use_shared_key_without_exposing_it(mode):
    settings = load_settings(CONFIG, environ={"MODE": mode, "API_KEY": "test-secret"})
    profile = settings.diagram.profiles[settings.diagram.active_profile]
    assert profile.provider == {"claude": "anthropic"}.get(mode, mode)
    registry = DiagramRegistry(settings, environ={"API_KEY": "test-secret"})
    assert registry.availability(settings.diagram.active_profile) == (True, None)
    assert "test-secret" not in settings.model_dump_json()


def test_blank_mode_preserves_yaml_selection(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text(CONFIG.read_text())
    (tmp_path / "settings.advanced.yaml").write_text(
        CONFIG.with_name("settings.advanced.yaml").read_text()
    )
    config = load_settings(path, environ={"MODE": "", "API_KEY": "test-secret"})
    assert config.diagram.active_profile == "groq-default"
    assert config.diagram.profiles["groq-default"].api_key_env == "API_KEY"


def test_invalid_mode_has_safe_error():
    with pytest.raises(ConfigurationError) as error:
        load_settings(CONFIG, environ={"MODE": "wrong-secret"})
    assert "wrong-secret" not in str(error.value)


def test_dotenv_loads_from_release_directory_and_shell_wins(tmp_path, monkeypatch):
    import os

    import app.config.settings as module

    backend = tmp_path / "backend"
    (backend / "config").mkdir(parents=True)
    (backend / "config/settings.yaml").write_text(CONFIG.read_text())
    (backend / "config/settings.advanced.yaml").write_text(
        CONFIG.with_name("settings.advanced.yaml").read_text()
    )
    (tmp_path / ".env").write_text("MODE=groq\nAPI_KEY=dotenv-secret\n")
    monkeypatch.setattr(module, "BACKEND_DIR", backend)
    monkeypatch.delenv("MODE", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.delenv("WHITEBOARD_CONFIG", raising=False)
    monkeypatch.chdir(Path(backend.anchor))
    settings = load_settings()
    assert settings.diagram.active_profile == "groq-default"
    assert DiagramRegistry(settings).availability("groq-default") == (True, None)
    assert "MODE" not in os.environ
    assert "API_KEY" not in os.environ
    monkeypatch.setenv("MODE", "mock")
    assert load_settings().diagram.active_profile == "mock"


def test_packaged_mock_boots_and_creates_session():
    env = {"MODE": "mock", "WHITEBOARD__TRANSCRIPTION__DEFAULT_PROFILE": "mock"}
    with TestClient(create_app(load_settings(CONFIG, environ=env))) as client:
        assert client.get("/health/ready").status_code == 200
        response = client.post("/api/v1/sessions", json={})
        assert response.status_code == 201
        assert response.json()["diagramProfile"] == "mock"


def test_starter_defaults_and_environment_precedence(tmp_path):
    path = tmp_path / "settings.yaml"
    starter = yaml.safe_load(CONFIG.read_text())
    assert set(starter) == {"mode", "model", "speech_profile"}
    path.write_text(yaml.safe_dump(starter))
    advanced = yaml.safe_load(CONFIG.with_name("settings.advanced.yaml").read_text())
    advanced["server"]["port"] = 8001
    (tmp_path / "settings.advanced.yaml").write_text(yaml.safe_dump(advanced))
    settings = load_settings(path, environ={})
    assert settings.diagram.active_profile == "groq-default"
    assert settings.diagram.profiles["groq-default"].model == "openai/gpt-oss-120b"
    assert settings.transcription.default_profile == "whisper-small"
    assert settings.server.port == 8001
    settings = load_settings(path, environ={"MODE": "claude", "WHITEBOARD__SERVER__PORT": "8002"})
    assert settings.diagram.active_profile == "claude-default"
    assert settings.server.port == 8002


def test_starter_model_override_and_unknown_fields(tmp_path):
    path = tmp_path / "settings.yaml"
    (tmp_path / "settings.advanced.yaml").write_text(
        CONFIG.with_name("settings.advanced.yaml").read_text()
    )
    path.write_text("mode: groq\nmodel: custom-model\nspeech_profile: mock\n")
    settings = load_settings(path, environ={})
    assert settings.diagram.profiles["groq-default"].model == "custom-model"
    assert settings.transcription.default_profile == "mock"
    path.write_text("mode: groq\nunknown_secret: do-not-echo\n")
    with pytest.raises(ConfigurationError) as error:
        load_settings(path, environ={})
    assert "do-not-echo" not in str(error.value)


def test_model_initialization_downloads_only_when_needed(monkeypatch):
    from scripts.models import ensure

    settings = load_settings(CONFIG, environ={})
    calls = []
    monkeypatch.setattr(ensure, "install", lambda *args: calls.append(args))
    monkeypatch.setattr(ensure, "model_valid", lambda path: False)
    ensure.ensure_models(settings)
    assert calls == [("whisper-small", BACKEND_DIR / "models")]
    calls.clear()
    monkeypatch.setattr(ensure, "model_valid", lambda path: True)
    ensure.ensure_models(settings)
    assert not calls
    settings.transcription.default_profile = "mock"
    ensure.ensure_models(settings)
    assert not calls
