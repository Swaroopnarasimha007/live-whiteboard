from collections.abc import Callable
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import router as network_router
from app.config import Settings, load_settings
from app.config.capabilities import Capabilities, public_capabilities
from app.contracts.interfaces import ProviderError
from app.diagnostics import diagnostic
from app.diagram import DiagramRegistry, GenerationService
from app.sessions import SessionError, SessionRegistry
from app.speech import SpeechError, SpeechRegistry


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


class RequestBoundary:
    """Bound complete HTTP bodies before validation; enforce WS origins at the ASGI boundary."""

    def __init__(self, app, *, settings: Settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin", b"").decode("latin1")
        if (
            scope["type"] == "http"
            and origin
            and origin not in self.settings.server.allowed_origins
        ):
            await JSONResponse(
                status_code=403,
                content={"error": {"code": "origin_denied", "message": "Origin is not allowed."}},
            )(scope, receive, send)
            return
        if scope["type"] == "websocket" and origin not in self.settings.server.allowed_origins:
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] == "http" and scope.get("method") in ("POST", "PUT", "PATCH"):
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > self.settings.server.max_request_bytes:
                    response = JSONResponse(
                        status_code=413,
                        content={
                            "error": {
                                "code": "request_too_large",
                                "message": "Request exceeds configured byte limit.",
                            }
                        },
                    )
                    await response(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            delivered = False

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()

            await self.app(scope, bounded_receive, send)
            return
        await self.app(scope, receive, send)


def create_app(settings: Settings | None = None, *, configure: Callable | None = None) -> FastAPI:
    effective = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with AsyncExitStack() as stack:
            app.state.resources = stack
            app.state.speech_registry = SpeechRegistry(effective)
            stack.push_async_callback(app.state.speech_registry.aclose)
            app.state.diagram_registry = DiagramRegistry(effective)
            app.state.generation_service = GenerationService(app.state.diagram_registry)
            stack.push_async_callback(app.state.diagram_registry.aclose)
            # Tests can substitute component services before the session layer binds them.
            if configure is not None:
                await configure(app, stack)
            app.state.session_registry = SessionRegistry(
                effective,
                app.state.speech_registry,
                app.state.diagram_registry,
                app.state.generation_service,
            )
            app.state.session_registry.background(app.state.session_registry.sweep())
            stack.push_async_callback(app.state.session_registry.aclose)
            await app.state.speech_registry.preload()
            app.state.ready = True
            diagnostic(
                "backend.ready",
                speech_profile=effective.transcription.default_profile,
                diagram_profile=effective.diagram.active_profile,
                model=effective.diagram.profiles[effective.diagram.active_profile].model,
            )
            try:
                yield
            finally:
                app.state.ready = False

    app = FastAPI(title="Live Whiteboard Backend", version="0.1.0", lifespan=lifespan)
    app.state.settings = effective
    app.state.ready = False
    app.add_middleware(RequestBoundary, settings=effective)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=effective.server.allowed_origins,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        diagnostic(
            "http.validation_error",
            warning=True,
            method=request.method,
            route=request.scope.get("route").path if request.scope.get("route") else "unknown",
            errors=len(exc.errors()),
        )
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "Request does not match the published contract.",
                }
            },
        )

    @app.exception_handler(SessionError)
    async def session_error(request, exc):
        diagnostic("http.session_error", warning=True, code=exc.code, status=exc.status)
        return JSONResponse(
            status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}}
        )

    @app.exception_handler(ProviderError)
    @app.exception_handler(SpeechError)
    async def provider_error(request, exc):
        diagnostic("http.provider_error", warning=True, code=exc.code)
        status = (
            413
            if exc.code == "context_too_large"
            else 422
            if exc.code in ("invalid_output", "unsupported_parameter", "profile_selection_disabled")
            else 503
        )
        return JSONResponse(
            status_code=status, content={"error": {"code": exc.code, "message": exc.message}}
        )

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.get("/health/live")
    async def live():
        return {"status": "live"}

    @app.get("/health/ready")
    async def ready():
        return JSONResponse(
            status_code=200 if app.state.ready else 503,
            content={
                "status": "ready" if app.state.ready else "starting",
                "stage": "B3",
                "servicesImplemented": True,
            },
        )

    router = APIRouter(prefix="/api/v1")

    @router.get("/capabilities", response_model=Capabilities)
    async def capabilities(request: Request, config: Annotated[Settings, Depends(get_settings)]):
        return public_capabilities(
            config,
            getattr(request.app.state, "speech_registry", None),
            getattr(request.app.state, "diagram_registry", None),
        )

    app.include_router(router)
    app.include_router(network_router)
    return app
