# Financial Agent web client

The Financial Agent client is a React 19 and Vite 6 workspace for persistent Topics, multi-Topic Research, live stock charts, and paper strategy management.

See the [project README](../README.md) for the complete setup, architecture, provider configuration, and current limitations.

## Development

Configure the backend from the repository root first, then run:

```bash
pnpm install
pnpm dev
```

The client opens at [http://localhost:5173](http://localhost:5173). In development it sends API requests to `http://localhost:${SERVER_PORT}` by default. Set `SERVER_BASE_URL` in the root `.env` file to override that target.

## Build

```bash
pnpm build
pnpm preview
```

The production client is emitted to `client/dist/` and is served by the root Node server after it has been built.
