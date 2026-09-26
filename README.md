# SentryDockAgent

**SentryDockAgent** is the worker that runs on each Docker host. It connects **outbound** to **SentryDockServer**, keeps a long-lived session, and executes whatever the control plane asks against the local Docker Engine.

You do not open inbound ports on the agent host. The agent reaches the panel (WebSocket or gRPC); the panel never SSHs in.

---

## What this project does

### Execute Docker work for the control plane

When a flow on the server needs to inspect containers, check a registry digest, pull an image, recreate a container (including digest-pinned rollback), list tags, apply or tear down a Compose project, or read disk inventory, it sends a command to this agent. The agent talks to Docker via the engine socket and returns structured results (and optional log streams).

Supported command surface is defined in [protocol/PROTOCOL.md](protocol/PROTOCOL.md) (`docker.*`, `image.*`, `inventory.*`).

### Stay online without a public IP

- Authenticates with an **agent token** issued in the panel (the name is only a label)
- Transports: **WebSocket (Socket.IO)** or **gRPC** — same message contract
- Reconnects with backoff if the link drops
- Sends heartbeats and periodic **inventory** (disk usage, dangling images) so the dashboard can warn you

### Isolate blast radius per host

Each agent only controls the Docker Engine it can reach (usually the host socket). Compromise of one token affects that host; other agents and the panel stay separate. Treat the token like a root Docker credential.

### How it fits SentryDock

| Piece | Responsibility |
|-------|----------------|
| **SentryDockServer** | UI, users, flows, scheduling, secrets, run history |
| **SentryDockAgent** (this repo) | Local Docker execution + inventory reporting |

Without agents, the panel has nothing to drive. Without the panel, the agent has no jobs to run.

---

## Quick start

1. In **SentryDockServer**: **Agents → Create** → copy the token.  
2. Here:

```bash
cp .env.example .env
# AGENT_TOKEN=...
# SENTRYDOCK_URL=https://panel.example   # or http://host.docker.internal:3000 locally
# AGENT_TRANSPORT=ws                     # or grpc (+ SENTRYDOCK_GRPC_URL)
docker compose up -d --build
```

Compose mounts `/var/run/docker.sock` and uses `host.docker.internal` to reach a panel on the host.

### Local development

```bash
cp .env.example .env
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

For WebSocket, set `AGENT_TRANSPORT=ws` (no gRPC URL required).

---

## Configuration

| Variable | Default | Notes |
|----------|---------|--------|
| `AGENT_TOKEN` | — | **Required** (from the panel) |
| `AGENT_NAME` | `agent-1` | Display label only |
| `AGENT_TRANSPORT` | `ws` | `ws` or `grpc` |
| `SENTRYDOCK_URL` | — | Panel HTTP(S) URL |
| `SENTRYDOCK_GRPC_URL` | — | `host:port` when using gRPC |
| `DOCKER_SOCKET` | auto | Force socket path; unset = auto-detect |
| `SENTRYDOCK_COMPOSE_DIR` | `~/.sentrydock/compose` | Directory for catalog Compose files (`docker.compose.apply`). **Must be on a volume** when the agent runs in Docker, or updates wipe the files. The bundled `docker-compose.yml` mounts a named volume at `/var/lib/sentrydock/compose`. |

### Docker socket

By default the agent resolves the same engine as the local `docker` CLI (context, Docker Desktop, rootless, or `/var/run/docker.sock`). Override with `DOCKER_SOCKET` when needed.

In a container the process runs as root on purpose (socket access), similar to a Portainer-style agent.

### Catalog Compose persistence

Projects deployed from the panel are written under `SENTRYDOCK_COMPOSE_DIR/<project>/docker-compose.yml`. The panel database remains the source of truth (redeploy rewrites the files), but without a volume a container recreate still loses local files until the next deploy and can break path-based `compose up` in flows. Keep the named volume from `docker-compose.yml` (or bind-mount a host directory). Do not use `docker compose down -v` unless you intend to drop that data.
### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Watch mode |
| `pnpm build` / `pnpm start` | Production build / run |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Quality gates |

Production should use `https://` (and TLS for gRPC) toward the panel — see `DEPLOYMENT.md` on **SentryDockServer**.

---

## Related docs

- [protocol/PROTOCOL.md](protocol/PROTOCOL.md) — command and event contract
- **SentryDockServer** — control plane (separate repo)
