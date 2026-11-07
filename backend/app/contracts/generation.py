import re
from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, model_validator

from .base import Contract, Coordinate, Counter, Dimension, Id
from .operations import Color, EdgeLabel, Label, Operation, Shape, Source, Title


class Point(Contract):
    x: Coordinate
    y: Coordinate


class Box(Point):
    width: Annotated[float, Field(ge=0, le=200000)]
    height: Annotated[float, Field(ge=0, le=200000)]


class Viewport(Contract):
    x: float
    y: float
    scale: Annotated[float, Field(ge=0.15, le=4)]


class ContextSection(Contract):
    id: Id
    title: Title
    origin: Point
    bounds: Box


class ContextNode(Point):
    id: Id
    sectionId: Id
    type: Shape
    label: Label
    color: Color
    width: Dimension
    height: Dimension
    locked: bool
    source: Source
    revision: Annotated[Counter, Field(ge=1)]


class ContextEdge(Contract):
    id: Id
    sectionId: Id
    from_: Id = Field(alias="from")
    to: Id
    kind: Literal["arrow", "line"]
    label: EdgeLabel
    color: Color
    source: Source
    locked: bool
    revision: Annotated[Counter, Field(ge=1)]


class BoardContext(Contract):
    activeSectionId: Id | None
    sections: Annotated[list[ContextSection], Field(max_length=100)]
    nodes: Annotated[list[ContextNode], Field(max_length=5000)]
    edges: Annotated[list[ContextEdge], Field(max_length=5000)]
    viewport: Viewport
    visibleWorldBounds: Box
    selectedIds: list[Id]
    contextComplete: Literal[True]
    omittedEntityCount: Literal[0]


class Transcript(Contract):
    segmentIds: Annotated[list[Id], Field(min_length=1)]
    text: Annotated[str, Field(min_length=1, max_length=10000)]
    startMs: Annotated[float, Field(ge=0)]
    endMs: Annotated[float, Field(ge=0)]

    @model_validator(mode="after")
    def check(self):
        if self.endMs < self.startMs or len(set(self.segmentIds)) != len(self.segmentIds):
            raise ValueError("Invalid transcript interval or duplicate segment IDs")
        return self


def entity_id(value: str, source: Source) -> bool:
    return bool(
        re.fullmatch(
            r"g_.+"
            if source == "generated"
            else r"m_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            value,
        )
    )


class GenerationRequest(Contract):
    protocolVersion: Literal[1]
    requestId: Id
    sessionId: Id
    sessionEpoch: Counter
    baseRevision: Counter
    idPrefix: Id
    transcript: Transcript
    board: BoardContext

    @model_validator(mode="after")
    def check(self):
        if not re.fullmatch(r"g_.+_", self.idPrefix):
            raise ValueError("Invalid generated prefix")
        b = self.board
        all_entities = [*b.sections, *b.nodes, *b.edges]
        ids = {e.id for e in all_entities}
        sections = {s.id for s in b.sections}
        nodes = {n.id: n for n in b.nodes}
        if len(ids) != len(all_entities) or len(b.nodes) + len(b.edges) > 5000:
            raise ValueError("Duplicate IDs or entity limit exceeded")
        if b.activeSectionId is not None and b.activeSectionId not in sections:
            raise ValueError("Missing active section")
        if len(set(b.selectedIds)) != len(b.selectedIds) or not set(b.selectedIds) <= ids:
            raise ValueError("Invalid selection")
        for e in [*b.nodes, *b.edges]:
            if (
                not entity_id(e.id, e.source)
                or e.sectionId not in sections
                or e.revision > self.baseRevision
            ):
                raise ValueError("Invalid context entity")
        for n in b.nodes:
            if (n.type == "circle" and n.width != n.height) or (
                not n.label.strip() and n.source != "manual"
            ):
                raise ValueError("Invalid node geometry/label")
        for e in b.edges:
            if (
                e.from_ not in nodes
                or e.to not in nodes
                or e.from_ == e.to
                or nodes[e.from_].sectionId != e.sectionId
                or nodes[e.to].sectionId != e.sectionId
            ):
                raise ValueError("Invalid context edge")
        return self


class EventBase(Contract):
    wireVersion: Literal[1]
    requestId: Id
    sessionEpoch: Counter
    sequence: Annotated[Counter, Field(ge=1)]


class Started(EventBase):
    event: Literal["started"]
    baseRevision: Counter


class OperationEvent(EventBase):
    event: Literal["operation"]
    baseRevision: Counter
    operation: Operation


class WarningEvent(EventBase):
    event: Literal["warning"]
    code: str
    message: str


class Completed(EventBase):
    event: Literal["completed"]
    operationCount: Counter
    warningCount: Counter


class Failed(EventBase):
    event: Literal["failed"]
    code: str
    message: str
    retryable: bool = False


class Cancelled(EventBase):
    event: Literal["cancelled"]
    reason: str


GenerationEvent = Annotated[
    Started | OperationEvent | WarningEvent | Completed | Failed | Cancelled,
    Field(discriminator="event"),
]
generation_event_adapter = TypeAdapter(GenerationEvent)
