FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app/backend
COPY pyproject.toml uv.lock ./
RUN pip install uv==0.13.7 && uv sync --frozen --no-dev --no-install-project --extra speech
COPY . .
RUN uv sync --frozen --no-dev --extra speech && useradd --create-home whiteboard \
    && mkdir -p models && chown -R whiteboard:whiteboard /app/backend
ENV PATH="/app/backend/.venv/bin:$PATH"
USER whiteboard
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--ws-max-size", "65536", "--ws-max-queue", "4", "--ws-per-message-deflate", "false"]
