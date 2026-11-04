from typing import Annotated, Literal

from pydantic import ConfigDict, Field, TypeAdapter, model_validator

from .base import Contract, Coordinate, Id

Shape = Literal["rect", "roundRect", "circle", "ellipse", "diamond", "text"]
Color = Literal["neutral", "blue", "green", "orange", "red", "purple"]
Source = Literal["manual", "generated"]
Label = Annotated[str, Field(max_length=500)]
EdgeLabel = Annotated[str, Field(max_length=200)]
Title = Annotated[str, Field(min_length=1, max_length=120)]


class RightOf(Contract):
    rightOf: Id


class Below(Contract):
    below: Id


class LeftOf(Contract):
    leftOf: Id


class Above(Contract):
    above: Id


class SectionAdd(Contract):
    op: Literal["section.add"]
    id: Id
    title: Title


class NodeAdd(Contract):
    model_config = ConfigDict(json_schema_extra={"not": {"required": ["at", "place"]}})
    op: Literal["node.add"]
    id: Id
    section: Id
    type: Shape
    label: Annotated[Label, Field(pattern=r"\S")]
    color: Color = "neutral"
    at: Annotated[list[Coordinate], Field(min_length=2, max_length=2)] | None = None
    place: RightOf | Below | LeftOf | Above | None = None

    @model_validator(mode="after")
    def check(self):
        if not self.label.strip() or (self.at is not None and self.place is not None):
            raise ValueError("Nonempty label and at OR place required")
        return self


class EdgeAdd(Contract):
    op: Literal["edge.add"]
    id: Id
    section: Id
    from_: Id = Field(alias="from")
    to: Id
    kind: Literal["arrow", "line"] = "arrow"
    label: EdgeLabel = ""
    color: Color = "neutral"


class NodeSet(Contract):
    model_config = ConfigDict(json_schema_extra={"minProperties": 1})
    label: Annotated[Label, Field(pattern=r"\S")] | None = None
    color: Color | None = None
    type: Shape | None = None
    at: Annotated[list[Coordinate], Field(min_length=2, max_length=2)] | None = None

    @model_validator(mode="after")
    def check(self):
        if not self.model_fields_set or any(
            getattr(self, k) is None for k in self.model_fields_set
        ):
            raise ValueError("Empty/null patch")
        if self.label is not None and not self.label.strip():
            raise ValueError("Nonempty label required")
        return self


class EdgeSet(Contract):
    model_config = ConfigDict(json_schema_extra={"minProperties": 1})
    label: EdgeLabel | None = None
    color: Color | None = None

    @model_validator(mode="after")
    def check(self):
        if not self.model_fields_set or any(
            getattr(self, k) is None for k in self.model_fields_set
        ):
            raise ValueError("Empty/null patch")
        return self


class NodeUpdate(Contract):
    op: Literal["node.update"]
    id: Id
    set: NodeSet


class EdgeUpdate(Contract):
    op: Literal["edge.update"]
    id: Id
    set: EdgeSet


class EntityDelete(Contract):
    op: Literal["entity.delete"]
    id: Id


Operation = Annotated[
    SectionAdd | NodeAdd | EdgeAdd | NodeUpdate | EdgeUpdate | EntityDelete,
    Field(discriminator="op"),
]
operation_adapter = TypeAdapter(Operation)
