import hashlib
import json
import os
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import yaml
from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

BACKEND_DIR = Path(__file__).resolve().parents[2]
Positive = Annotated[int, Field(gt=0)]
Seconds = Annotated[float, Field(gt=0, allow_inf_nan=False)]


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def strict_literals(cls, value):
        from app.contracts.base import check_literal_types

        return check_literal_types(value, cls.model_fields)


class ServerSettings(ConfigModel):
    host: Literal["127.0.0.1", "localhost", "::1"] = "127.0.0.1"
    port: Annotated[int, Field(ge=1, le=65535)] = 8000
    allowed_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    workers: Literal[1] = 1
    max_request_bytes: Positive = 524288

    @model_validator(mode="after")
    def check(self):
        if not self.allowed_origins:
            raise ValueError("At least one explicit origin required")
        for origin in self.allowed_origins:
            url = urlsplit(origin)
            if (
                url.scheme not in ("http", "https")
                or not url.hostname
                or url.username
                or url.password
                or url.path
                or url.query
                or url.fragment
                or "*" in origin
            ):
                raise ValueError("Origins must be explicit HTTP(S) origins")
        return self


class SpeechProfile(ConfigModel):
    provider: Literal["whisper", "mock"]
    display_name: str = ""
    model_path: str | None = None
    language: str | None = None
    fixture: str | None = None
    device: Literal["cpu", "cuda"] = "cpu"
    compute_type: Literal["int8", "float16", "int8_float16", "float32"] = "int8"

    @model_validator(mode="after")
    def check(self):
        if self.provider == "whisper" and (
            not self.model_path or not self.language or self.fixture is not None
        ):
            raise ValueError("Whisper needs model_path/language and no fixture")
        if self.provider == "mock" and (
            not self.fixture or self.model_path is not None or self.language is not None
        ):
            raise ValueError("Mock needs fixture and no model settings")
        return self


class AudioSettings(ConfigModel):
    encoding: Literal["pcm_s16le"] = "pcm_s16le"
    sample_rate_hz: Literal[16000] = 16000
    channels: Literal[1] = 1
    frame_ms: Annotated[int, Field(ge=1, le=1000)] = 100
    max_buffer_ms: Annotated[int, Field(ge=2000, le=120000)] = 60000

    @model_validator(mode="after")
    def check(self):
        if self.max_buffer_ms < self.frame_ms:
            raise ValueError("Buffer must hold at least one frame")
        return self


class Endpointing(ConfigModel):
    partial_emit_interval_ms: Positive = 150
    max_segment_ms: Annotated[int, Field(ge=1000, le=30000)] = 15000
    target_chunk_ms: Positive = 8000
    silence_ms: Positive = 600
    context_ms: Annotated[int, Field(ge=0, le=2000)] = 500

    @model_validator(mode="after")
    def check(self):
        if self.target_chunk_ms > self.max_segment_ms:
            raise ValueError("Chunk target must not exceed maximum")
        return self


class ModelCache(ConfigModel):
    max_loaded_models: Positive = 2
    max_active_recognizers: Positive = 2


def speech_profiles():
    return {
        "mock": SpeechProfile(
            provider="mock", fixture="request-flow", display_name="Mock transcript"
        ),
        "whisper-small": SpeechProfile(
            provider="whisper",
            model_path="models/faster-whisper-small",
            language="en",
            display_name="Whisper Small",
        ),
        "whisper-medium": SpeechProfile(
            provider="whisper",
            model_path="models/faster-whisper-medium",
            language="en",
            display_name="Whisper Medium",
        ),
    }


class TranscriptionSettings(ConfigModel):
    default_profile: str = "mock"
    allow_client_profile_selection: bool = True
    enabled_profiles: list[str] = Field(
        default_factory=lambda: ["mock", "whisper-small", "whisper-medium"]
    )
    profiles: dict[str, SpeechProfile] = Field(default_factory=speech_profiles)
    audio: AudioSettings = Field(default_factory=AudioSettings)
    endpointing: Endpointing = Field(default_factory=Endpointing)
    model_cache: ModelCache = Field(default_factory=ModelCache)

    @model_validator(mode="after")
    def check(self):
        validate_selection(self.default_profile, self.enabled_profiles, self.profiles)
        return self


class ModelCapabilities(ConfigModel):
    structured_output: bool = False
    structured_output_streaming: bool = False
    text_streaming: bool = True
    token_limit_parameter: Literal[
        "max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens"
    ] = "max_output_tokens"
    temperature_support: bool = False
    context_limit: Positive = 8192
    output_limit: Positive = 2048
    reasoning_controls: list[str] = Field(default_factory=list)
    cancellation_guarantee: Literal["local_only", "acknowledged"] = "local_only"
    verified: bool = False


class DiagramProfile(ConfigModel):
    provider: Literal["mock", "groq", "openrouter", "openai", "gemini", "anthropic"]
    model: Annotated[str, Field(min_length=1)]
    display_name: str = ""
    api_key_env: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]*$")] | None = None
    # Adapter-specific options are validated by B2 before use, never forwarded blindly.
    options: dict[str, object] = Field(default_factory=dict, repr=False)
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)

    @model_validator(mode="after")
    def check(self):
        if self.provider == "mock" and (self.api_key_env is not None or self.options):
            raise ValueError("Mock does not accept credentials/provider options")
        if self.provider != "mock" and not self.api_key_env:
            raise ValueError("Real profile needs an environment variable reference")
        return self


class DiagramSettings(ConfigModel):
    active_profile: str = "mock"
    allow_client_profile_selection: bool = False
    enabled_profiles: list[str] = Field(default_factory=lambda: ["mock"])
    profiles: dict[str, DiagramProfile] = Field(
        default_factory=lambda: {"mock": DiagramProfile(provider="mock", model="request-flow")}
    )
    connect_timeout_seconds: Seconds = 10
    first_text_timeout_seconds: Seconds = 15
    idle_text_timeout_seconds: Seconds = 15
    provider_timeout_seconds: Seconds = 30
    max_operations_per_request: Positive = 128
    max_context_bytes: Positive = 262144
    max_output_line_bytes: Positive = 65536
    max_partial_buffer_bytes: Positive = 131072
    max_output_tokens: Positive = 2048

    @model_validator(mode="after")
    def check(self):
        validate_selection(self.active_profile, self.enabled_profiles, self.profiles)
        if self.max_partial_buffer_bytes < self.max_output_line_bytes:
            raise ValueError("Partial buffer must hold one line")
        if (
            max(
                self.connect_timeout_seconds,
                self.first_text_timeout_seconds,
                self.idle_text_timeout_seconds,
            )
            > self.provider_timeout_seconds
        ):
            raise ValueError("Per-stage timeout exceeds total timeout")
        return self


def validate_selection(default, enabled, profiles):
    import re

    from app.contracts.base import valid_id

    if (
        len(set(enabled)) != len(enabled)
        or default not in enabled
        or not set(enabled) <= profiles.keys()
    ):
        raise ValueError("Invalid enabled/default profile selection")
    for name in profiles:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
            raise ValueError("Invalid profile ID")
        valid_id(name)


class SessionSettings(ConfigModel):
    max_sessions: Positive = 8
    idle_ttl_seconds: Positive = 900
    replay_ttl_seconds: Positive = 300
    replay_max_bytes_per_session: Positive = 4194304
    max_pending_events: Positive = 256


class LoggingSettings(ConfigModel):
    include_transcript: bool = False
    include_audio: Literal[False] = False


class Settings(ConfigModel):
    server: ServerSettings = Field(default_factory=ServerSettings)
    transcription: TranscriptionSettings = Field(default_factory=TranscriptionSettings)
    diagram: DiagramSettings = Field(default_factory=DiagramSettings)
    sessions: SessionSettings = Field(default_factory=SessionSettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)

    def model_path(self, profile: str) -> Path | None:
        value = self.transcription.profiles[profile].model_path
        if value is None:
            return None
        path = Path(value).expanduser()
        return (BACKEND_DIR / path).resolve() if not path.is_absolute() else path.resolve()

    def fingerprint(self) -> str:
        return hashlib.sha256(json.dumps(self.model_dump(), sort_keys=True).encode()).hexdigest()


class ConfigurationError(ValueError):
    pass


def merge(base: dict, override: dict) -> dict:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        else:
            base[key] = value
    return base


def environment() -> dict[str, str]:
    """Read release configuration without changing the caller's process environment."""
    values = dotenv_values(BACKEND_DIR.parent / ".env")
    return {**{key: value for key, value in values.items() if value is not None}, **os.environ}


def load_settings(
    path: str | Path | None = None, *, environ: dict[str, str] | None = None
) -> Settings:
    env = environment() if environ is None else environ
    selected = path or env.get("WHITEBOARD_CONFIG")
    if selected is None and environ is None:
        selected = "config/settings.yaml"
    data = Settings().model_dump()
    try:
        if selected:
            config_path = Path(selected)
            if not config_path.is_absolute():
                config_path = BACKEND_DIR / config_path
            loaded = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("Expected YAML mapping")
            merge(data, loaded)
        for name, value in env.items():
            if name.startswith("WHITEBOARD__"):
                keys = name.removeprefix("WHITEBOARD__").lower().split("__")
                target = data
                for key in keys[:-1]:
                    if key not in target or not isinstance(target[key], dict):
                        raise ValueError("Unknown environment setting")
                    target = target[key]
                if keys[-1] not in target:
                    raise ValueError("Unknown environment setting")
                target[keys[-1]] = yaml.safe_load(value)
        mode = env.get("MODE", "").strip().lower()
        if mode:
            mode = {"anthropic": "claude"}.get(mode, mode)
            profile = "mock" if mode == "mock" else f"{mode}-default"
            if profile not in data["diagram"]["profiles"]:
                raise ValueError("Unknown MODE")
            data["diagram"]["active_profile"] = profile
            data["diagram"]["enabled_profiles"] = [profile]
            if mode != "mock" and env.get("API_KEY", "").strip():
                data["diagram"]["profiles"][profile]["api_key_env"] = "API_KEY"
        elif env.get("API_KEY", "").strip():
            profile = data["diagram"]["active_profile"]
            if data["diagram"]["profiles"][profile]["provider"] != "mock":
                data["diagram"]["profiles"][profile]["api_key_env"] = "API_KEY"
        return Settings.model_validate(data)
    except (OSError, ValueError, yaml.YAMLError, ValidationError):
        # Do not include raw YAML, environment values, model paths or validation inputs.
        raise ConfigurationError(
            "Invalid backend configuration; check keys, types, profiles and limits."
        ) from None
