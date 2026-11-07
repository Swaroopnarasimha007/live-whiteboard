"""Public allowlisted profile readiness and implemented B3 network services."""

from typing import Literal

from pydantic import Field

from app.contracts.base import Contract, Id

from .settings import Settings


class ProfileCapability(Contract):
    id: Id
    displayName: str
    provider: str
    language: str | None
    available: bool
    reason: str | None = None
    capabilities: list[str] = Field(default_factory=list)


class Capabilities(Contract):
    protocolVersion: Literal[1] = 1
    wireVersion: Literal[1] = 1
    audioProtocolVersion: Literal[1] = 1
    stage: Literal["B3"] = "B3"
    transcriptionDefaultProfile: Id
    transcriptionSelectionEnabled: bool
    transcriptionProfiles: list[ProfileCapability]
    diagramDefaultProfile: Id
    diagramSelectionEnabled: bool
    diagramProfiles: list[ProfileCapability]
    services: dict[str, bool]


def public_capabilities(
    settings: Settings, speech_registry=None, diagram_registry=None
) -> Capabilities:
    if speech_registry is None:
        from app.speech import SpeechRegistry

        speech_registry = SpeechRegistry(settings)
    if diagram_registry is None:
        from app.diagram import DiagramRegistry

        diagram_registry = DiagramRegistry(settings)
    speech = []
    for name in settings.transcription.enabled_profiles:
        profile = settings.transcription.profiles[name]
        available, reason = speech_registry.availability(name)
        speech.append(
            ProfileCapability(
                id=name,
                displayName=profile.display_name or name,
                provider=profile.provider,
                language=profile.language,
                available=available,
                **({"reason": reason} if reason else {}),
                capabilities=["hold_to_talk", "final_transcript"],
            )
        )
    diagram = []
    for name in settings.diagram.enabled_profiles:
        profile = settings.diagram.profiles[name]
        available, reason = diagram_registry.availability(name)
        diagram.append(
            ProfileCapability(
                id=name,
                displayName=profile.display_name or name,
                provider=profile.provider,
                language=None,
                available=available,
                **({"reason": reason} if reason else {}),
                capabilities=["text_streaming"],
            )
        )
    return Capabilities(
        transcriptionDefaultProfile=settings.transcription.default_profile,
        transcriptionSelectionEnabled=settings.transcription.allow_client_profile_selection,
        transcriptionProfiles=speech,
        diagramDefaultProfile=settings.diagram.active_profile,
        diagramSelectionEnabled=settings.diagram.allow_client_profile_selection,
        diagramProfiles=diagram,
        services={
            "speech": True,
            "diagram": True,
            "sessions": True,
            "audio": True,
            "generation": True,
            "replay": True,
        },
    )
