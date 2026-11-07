import json

import pytest

from app.config import BACKEND_DIR, Settings
from app.contracts import GenerationRequest
from app.contracts.operations import operation_adapter
from app.diagram import OperationResult, WarningResult
from app.diagram.parser import OperationParser, ReferenceViolation
from app.prompts import build_prompt


def request(board_state):
    raw = json.loads(
        (BACKEND_DIR.parent / "shared/protocol/v1/fixtures.json").read_text(encoding="utf-8")
    )["generation-request"]["valid"][0]
    if board_state != "populated":
        raw["board"].update(nodes=[], edges=[], selectedIds=[])
    if board_state == "empty":
        raw["board"].update(sections=[], activeSectionId=None)
    return GenerationRequest.model_validate(raw)


@pytest.mark.parametrize("board_state", ["empty", "empty_section", "populated"])
def test_prompt_examples_are_executable_and_use_valid_first_node_placement(board_state):
    value = request(board_state)
    instructions, payload = build_prompt(value)
    data = json.loads(payload)
    assert data["board"] == value.model_dump()["board"]
    assert "OMIT place entirely" in instructions
    assert "not just a title" in instructions
    examples = [json.loads(line) for line in data["operationExamplesNdjson"].splitlines()]
    parser = OperationParser(value, Settings().diagram)
    results = list(parser.feed("".join(json.dumps(op) + "\n" for op in examples)))
    results += list(parser.finish())
    assert len(results) == len(examples)
    assert all(isinstance(item, OperationResult) for item in results)
    first = next(op for op in examples if op["op"] == "node.add")
    if board_state == "populated":
        assert first["place"]["rightOf"] in {node.id for node in value.board.nodes}
    else:
        assert first["at"] == [0, 0] and "place" not in first
    assert all(op["id"].startswith(value.idPrefix) for op in examples)
    assert sum(op["op"] == "section.add" for op in examples) == (board_state == "empty")


def test_empty_anchor_is_still_rejected_and_dependent_reference_is_reported():
    value = request("empty")
    parser = OperationParser(value, Settings().diagram)
    prefix = value.idPrefix
    records = [
        {"op": "section.add", "id": prefix + "s", "title": "Flow"},
        {
            "op": "node.add",
            "id": prefix + "a",
            "section": prefix + "s",
            "type": "rect",
            "label": "Source",
            "place": {"rightOf": ""},
        },
        {
            "op": "node.add",
            "id": prefix + "b",
            "section": prefix + "s",
            "type": "rect",
            "label": "Target",
            "place": {"rightOf": prefix + "a"},
        },
    ]
    results = list(parser.feed("".join(json.dumps(op) + "\n" for op in records)))
    results += list(parser.finish())
    assert [item.code for item in results if isinstance(item, WarningResult)] == [
        "invalid_output",
        "unresolved_reference",
    ]
    assert not any(
        isinstance(item, OperationResult) and item.operation.id == prefix + "a" for item in results
    )


def test_corrected_board_geometry_is_authoritative_in_next_prompt():
    value = request("populated")
    value.board.nodes[0].x = 176
    value.board.nodes[0].y = 96
    instructions, payload = build_prompt(value)
    board = json.loads(payload)["board"]
    assert board == value.model_dump()["board"]
    assert board["nodes"][0]["x"] == 176
    assert board["nodes"][0]["y"] == 96
    assert "authoritative committed result" in instructions
    assert "never restore older positions" in instructions


@pytest.mark.parametrize("reference_kind", ["section_as_anchor", "title_as_section", "self_anchor"])
def test_reference_rejections_have_specific_content_free_reasons(reference_kind):
    value = request("empty_section")
    parser = OperationParser(value, Settings().diagram)
    section = value.board.sections[0].id
    identifier = value.idPrefix + "new"
    record = {
        "op": "node.add",
        "id": identifier,
        "section": section,
        "type": "rect",
        "label": "Private concept",
    }
    if reference_kind == "section_as_anchor":
        record["place"] = {"rightOf": section}
        expected = "wrong_entity_kind"
    elif reference_kind == "title_as_section":
        record["section"] = "Private-topic-title"
        expected = "unknown_reference"
    else:
        record["place"] = {"rightOf": identifier}
        expected = "self_placement"
    with pytest.raises(ReferenceViolation) as error:
        parser.table.accept(operation_adapter.validate_python(record))
    assert error.value.code == expected
    assert "Private" not in str(error.value)
    assert identifier not in parser.table.entities
