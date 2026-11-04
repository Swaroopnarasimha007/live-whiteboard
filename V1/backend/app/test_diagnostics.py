import json

import pytest
from pydantic import ValidationError

from app.contracts.operations import operation_adapter
from app.diagnostics import schema_issues


def test_schema_diagnostics_include_field_types_without_values_or_unknown_keys():
    with pytest.raises(ValidationError) as caught:
        operation_adapter.validate_python(
            {
                "op": "node.add",
                "id": "g_test_node",
                "section": "g_test_section",
                "type": "PRIVATE_BAD_SHAPE",
                "label": "PRIVATE_BOARD_LABEL",
                "PRIVATE_EXTRA_FIELD": "PRIVATE_API_KEY",
            }
        )
    output = json.dumps(schema_issues(caught.value))
    assert "node.add.type" in output and "literal_error" in output
    assert "[field]" in output
    assert "PRIVATE" not in output and "input" not in output
