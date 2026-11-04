import json
import os
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from app.config import BACKEND_DIR, ConfigurationError, Settings, load_settings
from app.config.capabilities import public_capabilities
from app.contracts.audio import (
    AudioFormat,
    audio_client_adapter,
    audio_event_adapter,
    validate_pcm_frame,
)
from app.contracts.generation import GenerationRequest, generation_event_adapter
from app.contracts.operations import operation_adapter
from app.main import create_app

PROTOCOL = BACKEND_DIR.parent / "shared/protocol/v1"


def test_mock_defaults_and_path_resolution(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config = load_settings(environ={})
    assert config.transcription.default_profile == config.diagram.active_profile == "mock"
    assert config.model_path("whisper-small") == BACKEND_DIR / "models/faster-whisper-small"
    assert config.fingerprint() == load_settings(environ={}).fingerprint()


def test_precedence_and_example(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text("server:\n  port: 8001\n", encoding="utf-8")
    config = load_settings(path, environ={"WHITEBOARD__SERVER__PORT": "8002"})
    assert config.server.port == 8002
    example = load_settings("config/settings.example.yaml", environ={})
    assert len(example.diagram.profiles) == 6
    assert example.diagram.active_profile in example.diagram.enabled_profiles
    assert example.transcription.default_profile == "mock"


@pytest.mark.parametrize(
    "data",
    [
        {"server": {"workers": 2}},
        {"server": {"host": "0.0.0.0"}},
        {"server": {"allowed_origins": ["*"]}},
        {"server": {"port": True}},
        {"transcription": {"audio": {"sample_rate_hz": 48000}}},
        {"transcription": {"default_profile": "unknown"}},
        {"transcription": {"profiles": {"broken": {"provider": "mock", "model_path": "secret"}}}},
        {"diagram": {"profiles": {"bad": {"provider": "arbitrary.module", "model": "x"}}}},
        {"diagram": {"max_partial_buffer_bytes": 1}},
        {"unknown": "secret"},
    ],
)
def test_invalid_settings(data):
    from app.config.settings import merge

    with pytest.raises(ValidationError):
        Settings.model_validate(merge(Settings().model_dump(), data))


def test_config_error_does_not_echo_inputs(tmp_path):
    path = tmp_path / "secret.yaml"
    path.write_text("private_api_key: SUPER_SECRET", encoding="utf-8")
    with pytest.raises(ConfigurationError) as caught:
        load_settings(path, environ={})
    assert "SUPER_SECRET" not in str(caught.value)
    with pytest.raises(ConfigurationError):
        load_settings(environ={"WHITEBOARD__TYPO": "123"})


def test_capabilities_are_safe_and_honest(monkeypatch):
    config = Settings()
    monkeypatch.setenv("OPENAI_API_KEY", "SUPER_SECRET")
    result = public_capabilities(config).model_dump_json()
    for forbidden in ("model_path", "api_key_env", "options", "SUPER_SECRET", "C:\\", "models/"):
        assert forbidden not in result
    caps = json.loads(result)
    assert caps["services"]["speech"] is True
    assert caps["services"]["audio"] and caps["services"]["sessions"]
    assert next(p for p in caps["transcriptionProfiles"] if p["id"] == "mock")["available"] is True


def test_lifecycle_routes_cors_and_validation():
    cleaned = []

    async def configure(app, stack):
        async def cleanup():
            cleaned.append(True)

        stack.push_async_callback(cleanup)

    app = create_app(configure=configure)
    with TestClient(app) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").json()["stage"] == "B3"
        assert client.get("/api/v1/capabilities").status_code == 200
        assert client.post("/api/v1/sessions", json={}).status_code == 201
        invalid = client.post("/api/v1/sessions", json={"apiKey": "SUPER_SECRET"})
        assert invalid.status_code == 422 and "SUPER_SECRET" not in invalid.text
        assert (
            client.get(
                "/api/v1/capabilities", headers={"Origin": "https://evil.example"}
            ).headers.get("access-control-allow-origin")
            is None
        )
        allowed = client.options(
            "/api/v1/sessions",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
        )
        assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert (
            client.post(
                "/api/v1/generations", json=fixtures()["generation-request"]["valid"][0]
            ).status_code
            == 410
        )
        schema = client.get("/openapi.json").json()
        assert "/api/v1/generations/{request_id}/events" in schema["paths"]
    assert cleaned == [True] and not app.state.ready


def test_size_limit_and_websocket_origins():
    settings = load_settings(environ={"WHITEBOARD__SERVER__MAX_REQUEST_BYTES": "100"})
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/v1/sessions", content=b"x" * 101).status_code == 413
        for origin in (None, "https://evil.example"):
            with (
                pytest.raises(WebSocketDisconnect) as caught,
                client.websocket_connect(
                    "/api/v1/sessions/s1/audio",
                    headers={} if origin is None else {"Origin": origin},
                ),
            ):
                pass
            assert caught.value.code == 1008
        with (
            pytest.raises(WebSocketDisconnect) as caught,
            client.websocket_connect(
                "/api/v1/sessions/s1/audio", headers={"Origin": "http://localhost:5173"}
            ),
        ):
            pass
        assert caught.value.code == 1008


def test_pcm_frames():
    for size in (2, 3200, 32000):
        validate_pcm_frame(bytes(size), AudioFormat())
    for size in (0, 1, 32001, 32002):
        with pytest.raises(ValueError):
            validate_pcm_frame(bytes(size), AudioFormat())


def test_real_cli_startup_and_shutdown():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {key: value for key, value in os.environ.items() if not key.startswith("WHITEBOARD")}
    env["WHITEBOARD__SERVER__PORT"] = str(port)
    process = subprocess.Popen(
        [sys.executable, "-m", "app"],
        cwd=BACKEND_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with urlopen(f"http://127.0.0.1:{port}/health/ready", timeout=1) as response:
                    assert json.load(response)["status"] == "ready"
                break
            except URLError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    pytest.fail("Backend CLI failed to become ready")
                time.sleep(0.05)
        with urlopen(f"http://127.0.0.1:{port}/api/v1/capabilities", timeout=1) as response:
            assert json.load(response)["stage"] == "B3"
    finally:
        process.terminate()
        process.communicate(timeout=5)


def fixtures():
    return json.loads((PROTOCOL / "fixtures.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "name,adapter",
    [
        ("operation", operation_adapter),
        ("generation-request", GenerationRequest),
        ("generation-event", generation_event_adapter),
        ("audio-client-message", audio_client_adapter),
        ("audio-server-event", audio_event_adapter),
    ],
)
def test_shared_fixtures(name, adapter):
    parse = adapter.model_validate_json if name == "generation-request" else adapter.validate_json
    schema = json.loads((PROTOCOL / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    for value in fixtures()[name]["valid"]:
        parsed = parse(json.dumps(value))
        parse(parsed.model_dump_json())
        Draft202012Validator(schema).validate(value)
    for value in fixtures()[name]["invalid"]:
        with pytest.raises(ValidationError):
            parse(json.dumps(value))
