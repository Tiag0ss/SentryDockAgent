# SentryDock Agent

Agente Docker outbound (WebSocket ou gRPC) que controla o Docker Engine do host via `/var/run/docker.sock`.

## Quick start

1. No painel: **Agentes → Criar** e copia o token.
2. Configura env e sobe o contentor:

```bash
cp .env.example .env
# AGENT_TOKEN=...
# SENTRYDOCK_URL=https://painel.exemplo
# AGENT_TRANSPORT=ws   # ou grpc
docker compose up -d --build
```

## Desenvolvimento local

A autenticação é pelo `AGENT_TOKEN`. O `AGENT_NAME` é só uma label no painel (não identifica o agente).

```bash
pnpm install
AGENT_TOKEN=... SENTRYDOCK_URL=http://localhost:3000 AGENT_TRANSPORT=grpc SENTRYDOCK_GRPC_URL=localhost:50051 pnpm dev
```

Para WebSocket: `AGENT_TRANSPORT=ws`.

## Docker socket

Por defeito o agent detecta o mesmo engine que o CLI (`docker context`, Docker Desktop em `~/.docker/desktop/docker.sock`, rootless, ou `/var/run/docker.sock`).

Se precisares de forçar:

```bash
DOCKER_SOCKET=/var/run/docker.sock pnpm dev
# ou Docker Desktop:
DOCKER_SOCKET=$HOME/.docker/desktop/docker.sock pnpm dev
```

## Inventário

Periodicamente reporta uso de disco e imagens dangling ao painel (avisos no dashboard).

## Protocolo

Ver [protocol/PROTOCOL.md](protocol/PROTOCOL.md).
