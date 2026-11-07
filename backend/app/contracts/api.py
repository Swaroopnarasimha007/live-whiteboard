from .base import Contract, Counter, Id


class SessionCreate(Contract):
    sessionEpoch: Counter = 0
    profile: Id | None = None
    diagramProfile: Id | None = None


class SessionCreated(Contract):
    sessionId: Id
    sessionEpoch: Counter
    profile: Id
    diagramProfile: Id
    configurationFingerprint: str


class SessionOwner(Contract):
    sessionId: Id
    sessionEpoch: Counter


class ErrorDetail(Contract):
    code: str
    message: str


class ErrorResponse(Contract):
    error: ErrorDetail
