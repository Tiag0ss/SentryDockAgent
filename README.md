[![Docker Hub](https://img.shields.io/docker/pulls/tiag0ss/sentrydock-agent?label=Docker%20Pulls&logo=docker)](https://hub.docker.com/r/tiag0ss/sentrydock-agent)
[![Docker Image](https://img.shields.io/badge/Docker%20Hub-tiag0ss%2Fsentrydock--agent-blue?logo=docker)](https://hub.docker.com/r/tiag0ss/sentrydock-agent)

# SentryDockAgent

Per-host worker for **SentryDock**. It connects **outbound** to [SentryDockServer](https://github.com/Tiag0ss/sentrydockserver), keeps a long-lived session, and runs Docker / Compose commands against the local engine.

You do **not** open inbound ports on the agent host. The agent reaches the panel (WebSocket or gRPC); the panel never SSHs in.

This project is **functional** and usable day-to-day, but still in an **early stage** — expect rough edges. Please report bugs and ideas on GitHub.

## Features

- 🐳 **Local Docker execution** — Inspect containers, pull images, recreate (incl. digest-pinned rollback), list tags, apply / tear down Compose, read disk inventory
- 📡 **Outbound-only** — No public IP required; authenticates with an agent token from the panel
- 🔌 **WebSocket or gRPC** — Same message contract; reconnects with backoff
- 💓 **Heartbeats & inventory** — Disk usage, dangling images, container state for the dashboard
- 📈 **Metrics samples** — CPU / memory batches for the server dashboard (interval / retention from the panel)
- 📁 **Catalog Compose on disk** — Writes panel Compose projects under a persistent directory (named volume in Docker)

Command surface: [protocol/PROTOCOL.md](protocol/PROTOCOL.md) (`docker.*`, `image.*`, `inventory.*`, metrics).

## How it fits SentryDock

| Piece | Responsibility |
|-------|----------------|
| **[SentryDockServer](https://github.com/Tiag0ss/sentrydockserver)** | UI, users, flows, scheduling, secrets, run history |
| **SentryDockAgent** (this repo) | Local Docker execution + inventory / metrics |

Without agents, the panel has nothing to drive. Without the panel, the agent has no jobs to run.

Treat `AGENT_TOKEN` like a root Docker credential: one token = one host’s engine.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js, TypeScript |
| Docker | Engine socket (`dockerode`) |
| Transports | Socket.IO client or gRPC |
| Container | Alpine-based Node.js image — [`tiag0ss/sentrydock-agent`](https://hub.docker.com/r/tiag0ss/sentrydock-agent) |

## Local Development

1. In **SentryDockServer**: **Agents → Create** → copy the token.  
2. Here:

```bash
git clone https://github.com/Tiag0ss/SentryDockAgent.git
cd SentryDockAgent
cp .env.example .env
# AGENT_TOKEN=...
# SENTRYDOCK_URL=http://localhost:3000
pnpm install
pnpm dev
```

Example (gRPC → local panel):

```bash
AGENT_TOKEN=... \
SENTRYDOCK_URL=http://localhost:3000 \
SENTRYDOCK_GRPC_URL=localhost:50051 \
AGENT_TRANSPORT=grpc \
pnpm dev
```

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm build && pnpm start
```

## Quick Start (Docker)

### From Docker Hub

```bash
docker run -d \
  --name sentrydock-agent \
  -e SENTRYDOCK_URL=https://panel.example \
  -e AGENT_TOKEN=your-agent-token \
  -e AGENT_NAME=host-1 \
  -e AGENT_TRANSPORT=ws \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v sentrydock_compose:/var/lib/sentrydock/compose \
  tiag0ss/sentrydock-agent:latest
```

For a panel on the same Docker host, use `http://host.docker.internal:3000` and add `--add-host=host.docker.internal:host-gateway` (Linux).

### Build locally

```bash
cp .env.example .env
# set AGENT_TOKEN (+ SENTRYDOCK_URL)
docker compose up -d --build
```

Compose mounts `/var/run/docker.sock` and a named volume for catalog Compose files.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_TOKEN` | **Yes** | — | Token from the panel (**Agents → Create**) |
| `AGENT_NAME` | No | `agent-1` | Display label only |
| `AGENT_TRANSPORT` | No | `ws` | `ws` or `grpc` |
| `SENTRYDOCK_URL` | **Yes** | — | Panel HTTP(S) URL |
| `SENTRYDOCK_GRPC_URL` | If gRPC | — | `host:port` when using gRPC |
| `DOCKER_SOCKET` | No | auto | Force socket path; unset = auto-detect |
| `SENTRYDOCK_COMPOSE_DIR` | No | `~/.sentrydock/compose` | Catalog Compose files. **Must be a volume** in Docker. |

### Docker socket

By default the agent resolves the same engine as the local `docker` CLI (context, Docker Desktop, rootless, or `/var/run/docker.sock`). Override with `DOCKER_SOCKET` when needed.

In a container the process runs as root on purpose (socket access), similar to a Portainer-style agent.

### Catalog Compose persistence

Projects from the panel are written under `SENTRYDOCK_COMPOSE_DIR/<project>/docker-compose.yml`. Keep the named volume from `docker-compose.yml` (or a bind-mount). Do not use `docker compose down -v` unless you intend to drop that data.

## CI / CD

| System | File | When | What |
|--------|------|------|------|
| **GitHub Actions** | `.github/workflows/ci.yml` | push/PR to `main`/`master` | install, lint, test, typecheck |
| **Woodpecker** | `.woodpecker.yaml` | tag `V*` (e.g. `V0.2.3`) | checks, then build/push `tiag0ss/sentrydock-agent` (`latest` + version) |

## Updating

```bash
docker pull tiag0ss/sentrydock-agent:latest
docker compose up -d
```

Production should use `https://` (and TLS for gRPC) toward the panel — see `DEPLOYMENT.md` on **SentryDockServer**.

## Related

- 🐳 [Docker Hub — agent](https://hub.docker.com/r/tiag0ss/sentrydock-agent)
- 🐳 [Docker Hub — server](https://hub.docker.com/r/tiag0ss/sentrydock-server)
- 🎛️ [SentryDockServer](https://github.com/Tiag0ss/sentrydockserver) — control plane
- 🔌 [protocol/PROTOCOL.md](protocol/PROTOCOL.md) — command and event contract

## License

MIT
