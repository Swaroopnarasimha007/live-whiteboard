from typing import Annotated, Literal, get_args, get_origin

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_serializer, model_validator

RESERVED = {
    "__proto__",
    "prototype",
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
}


def valid_id(value: str) -> str:
    if value in RESERVED:
        raise ValueError("Reserved identifier")
    return value


Id = Annotated[
    str,
    Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
        json_schema_extra={"not": {"enum": sorted(RESERVED)}},
    ),
    AfterValidator(valid_id),
]
Counter = Annotated[int, Field(ge=0, le=9007199254740991)]
Coordinate = Annotated[float, Field(ge=-100000, le=100000, allow_inf_nan=False)]
Dimension = Annotated[float, Field(ge=24, le=2000, allow_inf_nan=False)]


def check_literal_types(value, fields):
    if isinstance(value, dict):
        for name, field in fields.items():
            key = field.alias or name
            if (
                key in value
                and get_origin(field.annotation) is Literal
                and not any(
                    type(value[key]) is type(option) for option in get_args(field.annotation)
                )
            ):
                raise ValueError("Literal has the wrong JSON type")
    return value


class Contract(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, allow_inf_nan=False, serialize_by_alias=True
    )

    @model_serializer(mode="wrap")
    def wire_dump(self, handler):
        result = handler(self)
        # Keep required nullable fields; omit absent optional fields on the wire.
        for name, field in type(self).model_fields.items():
            if not field.is_required() and field.default is None and getattr(self, name) is None:
                result.pop(field.alias or name, None)
        return result

    @model_validator(mode="before")
    @classmethod
    def reject_null_optionals(cls, value):
        check_literal_types(value, cls.model_fields)
        # Zod optional fields may be absent, but explicit null is invalid.
        if isinstance(value, dict):
            for name, field in cls.model_fields.items():
                key = field.alias or name
                if (
                    not field.is_required()
                    and field.default is None
                    and key in value
                    and value[key] is None
                ):
                    raise ValueError("Optional fields must be omitted rather than null")
        return value
