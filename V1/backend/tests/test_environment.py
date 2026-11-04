from pathlib import Path

import pytest
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
    path.write_text(
        CONFIG.read_text()
        .replace("active_profile: mock", "active_profile: groq-default")
        .replace(
            "enabled_profiles:\n  - mock\n  profiles:",
            "enabled_profiles:\n  - groq-default\n  profiles:",
        )
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
    with TestClient(create_app(load_settings(CONFIG, environ={"MODE": "mock"}))) as client:
        assert client.get("/health/ready").status_code == 200
        response = client.post("/api/v1/sessions", json={})
        assert response.status_code == 201
        assert response.json()["diagramProfile"] == "mock"
