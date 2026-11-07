import uvicorn

from app.config import load_settings
from app.main import create_app


def main():
    settings = load_settings()
    uvicorn.run(
        create_app(settings),
        host=settings.server.host,
        port=settings.server.port,
        workers=settings.server.workers,
        access_log=False,
        ws_max_size=65536,
        ws_max_queue=4,
        ws_per_message_deflate=False,
    )


if __name__ == "__main__":
    main()
