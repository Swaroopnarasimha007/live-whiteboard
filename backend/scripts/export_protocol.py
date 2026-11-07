"""Export B0 JSON Schemas and check drift with --check. Run from any directory."""

import argparse
import json
from pathlib import Path

from pydantic import TypeAdapter

from app.contracts.api import SessionCreate, SessionCreated, SessionOwner
from app.contracts.audio import AudioStart, audio_client_adapter, audio_event_adapter
from app.contracts.generation import GenerationRequest, generation_event_adapter
from app.contracts.operations import operation_adapter

ROOT = Path(__file__).resolve().parents[2] / "shared" / "protocol" / "v1"
SCHEMAS = {
    "operation": operation_adapter,
    "generation-request": TypeAdapter(GenerationRequest),
    "generation-event": generation_event_adapter,
    "audio-start": TypeAdapter(AudioStart),
    "audio-client-message": audio_client_adapter,
    "audio-server-event": audio_event_adapter,
    "session-create": TypeAdapter(SessionCreate),
    "session-created": TypeAdapter(SessionCreated),
    "session-owner": TypeAdapter(SessionOwner),
}


def normalize(schema):
    if isinstance(schema, dict):
        for prop in schema.get("properties", {}).values():
            if prop.get("default", "absent") is None:
                choices = [c for c in prop.get("anyOf", []) if c != {"type": "null"}]
                if choices:
                    prop.pop("default", None)
                    prop.pop("anyOf", None)
                    prop.update(choices[0] if len(choices) == 1 else {"anyOf": choices})
        for value in list(schema.values()):
            normalize(value)
    elif isinstance(schema, list):
        for value in schema:
            normalize(value)
    return schema


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--frontend-root", type=Path)
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, adapter in SCHEMAS.items():
        schema = normalize(adapter.json_schema(by_alias=True))
        schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
        schema["$id"] = f"urn:live-whiteboard:v1:{name}"
        output = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
        destination = ROOT / f"{name}.schema.json"
        if args.check:
            if not destination.exists() or destination.read_text(encoding="utf-8") != output:
                raise SystemExit(f"Schema drift: {name}")
        else:
            destination.write_text(output, encoding="utf-8")
    if args.frontend_root:
        source = ROOT / "fixtures.json"
        destination = args.frontend_root.resolve() / "tests/fixtures/backend-v1.json"
        if args.check:
            if not destination.exists() or json.loads(
                destination.read_text(encoding="utf-8")
            ) != json.loads(source.read_text(encoding="utf-8")):
                raise SystemExit(
                    "Frontend fixture drift: sync with --frontend-root without --check"
                )
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read_bytes())
    print(f"{'Checked' if args.check else 'Exported'} {len(SCHEMAS)} schemas")


if __name__ == "__main__":
    main()
