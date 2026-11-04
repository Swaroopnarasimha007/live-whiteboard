import json
from dataclasses import dataclass

from pydantic import ValidationError

from app.contracts.interfaces import ProviderError
from app.contracts.operations import operation_adapter
from app.diagnostics import diagnostic, schema_issues

from .events import OperationResult, WarningResult


class ReferenceViolation(ValueError):
    """Fixed diagnostic codes only; never include provider content."""

    def __init__(self, code):
        self.code = code
        super().__init__("Operation violates entity identity, reference or protection rules")


@dataclass(frozen=True)
class Entity:
    kind: str
    section: str | None = None
    source: str = "generated"
    locked: bool = False
    from_: str | None = None
    to: str | None = None


class ReferenceTable:
    """Request-local validation hints only; never an authoritative applied scene or layout."""

    def __init__(self, request, maximum):
        self.prefix, self.maximum = request.idPrefix, maximum
        self.entities = {s.id: Entity("section") for s in request.board.sections}
        self.entities.update(
            {n.id: Entity("node", n.sectionId, n.source, n.locked) for n in request.board.nodes}
        )
        self.entities.update(
            {
                e.id: Entity("edge", e.sectionId, e.source, e.locked, e.from_, e.to)
                for e in request.board.edges
            }
        )
        self.pending = {}
        self.deleted = set()

    def accept(self, operation):
        entities = self.entities.copy()
        pending = {key: list(value) for key, value in self.pending.items()}
        deleted = self.deleted.copy()
        identifier = operation.id

        def reject(code):
            raise ReferenceViolation(code)

        def expect(ref, kind, section=None):
            if ref in deleted:
                reject("deleted_reference")
            entity = entities.get(ref)
            if entity is not None:
                if entity.kind != kind:
                    reject("wrong_entity_kind")
                if section is not None and entity.section != section:
                    reject("cross_section_reference")
            elif ref.startswith(self.prefix):
                pending.setdefault(ref, []).append((kind, section, identifier))
            else:
                reject("unknown_reference")

        def protect(ref, kind=None):
            entity = entities.get(ref)
            if (
                entity is None
                or entity.kind == "section"
                or (kind and entity.kind != kind)
                or entity.source == "manual"
                or entity.locked
            ):
                reject("missing_or_protected_target")

        if operation.op.endswith(".add"):
            if (
                identifier in entities
                or identifier in deleted
                or not identifier.startswith(self.prefix)
            ):
                reject("duplicate_deleted_or_unprefixed_id")
            kind = operation.op.split(".")[0]
            section = getattr(operation, "section", None)
            entity = Entity(
                kind,
                section,
                from_=getattr(operation, "from_", None),
                to=getattr(operation, "to", None),
            )
            for expected, expected_section, _owner in pending.pop(identifier, []):
                if kind != expected or (
                    expected_section is not None and expected_section != section
                ):
                    reject("pending_reference_mismatch")
            entities[identifier] = entity
            if kind in ("node", "edge"):
                expect(section, "section")
            if kind == "node" and operation.place:
                anchor = next(iter(operation.place.model_dump().values()))
                if anchor == identifier:
                    reject("self_placement")
                expect(anchor, "node", section)
            if kind == "edge":
                if operation.from_ == operation.to:
                    reject("self_edge")
                expect(operation.from_, "node", section)
                expect(operation.to, "node", section)
        elif operation.op in ("node.update", "edge.update"):
            protect(identifier, operation.op.split(".")[0])
        else:
            protect(identifier)
            incident = [
                key
                for key, e in entities.items()
                if e.kind == "edge" and identifier in (e.from_, e.to)
            ]
            for key in incident:
                protect(key)
            for key in [identifier, *incident]:
                entities.pop(key)
                deleted.add(key)
            pending = {
                ref: [constraint for constraint in values if constraint[2] not in deleted]
                for ref, values in pending.items()
            }
            pending = {ref: values for ref, values in pending.items() if values}
        sections = sum(entity.kind == "section" for entity in entities.values())
        if len(pending) > self.maximum or sections > 100 or len(entities) - sections > 5000:
            reject("entity_or_pending_limit")
        self.entities, self.pending, self.deleted = entities, pending, deleted


class OperationParser:
    def __init__(self, request, settings):
        self.request_id = request.requestId
        self.settings = settings
        self.table = ReferenceTable(request, min(128, settings.max_operations_per_request))
        self.buffer = ""
        self.buffer_bytes = 0
        self.line = self.operations = self.warnings = self.invalid_streak = 0
        self.stop_on_invalid_streak = True

    def invalid(self, message):
        diagnostic(
            "operation.invalid",
            warning=True,
            request_id=self.request_id,
            line=self.line,
            message=message,
        )
        self.invalid_streak += 1
        self.warnings += 1
        yield WarningResult("invalid_output", message, self.line)
        if self.stop_on_invalid_streak and self.invalid_streak >= 3:
            raise ProviderError(
                "invalid_output", "Provider emitted three consecutive invalid operation records."
            )

    def record(self, text, *, final=False):
        self.line += 1
        if not text.strip():
            return
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            yield from self.invalid("Rejected malformed JSON operation record.")
            if final:
                raise ProviderError(
                    "invalid_output", "Provider ended with an incomplete final operation record."
                ) from None
            return
        try:
            operation = operation_adapter.validate_json(json.dumps(data, ensure_ascii=False))
            self.table.accept(operation)
        except (ValidationError, ValueError, TypeError) as exc:
            identifier = data.get("id") if isinstance(data, dict) else None
            target = self.table.entities.get(identifier) if isinstance(identifier, str) else None
            diagnostic(
                "operation.validation_rejected",
                warning=True,
                request_id=self.request_id,
                line=self.line,
                error_type=type(exc).__name__,
                reference_reason=exc.code if isinstance(exc, ReferenceViolation) else None,
                new_id_prefix_matches=isinstance(identifier, str)
                and identifier.startswith(self.table.prefix),
                target_exists=target is not None,
                target_locked=target.locked if target else None,
                target_source=target.source if target else None,
                issues=schema_issues(exc) if isinstance(exc, ValidationError) else [],
                placement_conflict=isinstance(data, dict)
                and data.get("op") == "node.add"
                and data.get("at") is not None
                and data.get("place") is not None,
                category="schema"
                if isinstance(exc, ValidationError)
                else "references_or_protection",
            )
            yield from self.invalid(
                "Rejected an operation with invalid schema, references or protected edits."
            )
            return
        if self.operations >= self.settings.max_operations_per_request:
            raise ProviderError("output_limit", "Generation exceeded the operation limit.")
        self.operations += 1
        self.invalid_streak = 0
        diagnostic(
            "operation.accepted",
            request_id=self.request_id,
            line=self.line,
            operation=operation.op,
        )
        yield OperationResult(operation)

    def feed(self, text):
        parts = text.split("\n")
        for index, part in enumerate(parts):
            complete = index < len(parts) - 1
            size = self.buffer_bytes + len(part.encode("utf-8"))
            if complete and size > self.settings.max_output_line_bytes:
                self.line += 1
                self.buffer, self.buffer_bytes = "", 0
                yield from self.invalid("Rejected operation record exceeding the line byte limit.")
                continue
            if size > self.settings.max_partial_buffer_bytes:
                raise ProviderError(
                    "output_limit", "Incomplete operation exceeds the buffer byte limit."
                )
            self.buffer += part
            self.buffer_bytes = size
            if complete:
                record, self.buffer, self.buffer_bytes = self.buffer, "", 0
                yield from self.record(record)

    def finish(self):
        if self.buffer:
            if self.buffer_bytes > self.settings.max_output_line_bytes:
                self.line += 1
                yield from self.invalid("Final operation exceeds the line byte limit.")
                raise ProviderError(
                    "invalid_output", "Provider ended with an oversized final record."
                )
            yield from self.record(self.buffer, final=True)
            self.buffer, self.buffer_bytes = "", 0
        if self.table.pending:
            self.warnings += 1
            yield WarningResult(
                "unresolved_reference",
                "Generation ended with unresolved request-local references; the frontend must reconcile pending operations.",
            )
