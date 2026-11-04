# Whiteboard frontend

See the [V1 startup guide](../README.md) for Docker, local installation, and backend configuration.

```sh
npm ci
npm run dev
```

Open http://localhost:5173. Start the backend in a separate terminal.
Vite proxies API and WebSocket traffic to 127.0.0.1:8000. The Docker image uses
Nginx for the same routes. API keys belong only in `V1/.env`.

```sh
npm test
npm run build
```
