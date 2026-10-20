# SentryDock Agent Protocol

Canonical contract between control plane and agents. Transports: **WebSocket (Socket.IO)** or **gRPC**. Both map to the same messages.

## Versions

- `protocolVersion`: `1`
- Agents send `agentVersion` + `protocolVersion` on `hello`.
- Control plane rejects agents below `MIN_PROTOCOL_VERSION` (default `1`).

## Auth

Outbound connection from agent with token:

- WS: `auth: { token, agentName }`
- gRPC: metadata `authorization: Bearer <token>`, `agent-name`, `protocol-version`

`token` authenticates (source of truth). `agentName` is a display label only.

## Commands (server → agent)

| type | payload |
|------|---------|
| `docker.list` | `{ all?: boolean, withStats?: boolean }` → containers (+ optional cpu/mem/size) |
| `docker.inspect` | `{ id: string }` |
| `docker.stats` | `{ id: string }` → `{ cpuPercent, memoryUsageBytes, memoryLimitBytes, sizeRwBytes?, sizeRootFsBytes? }` |
| `docker.start` | `{ id: string }` |
| `docker.stop` | `{ id: string, timeoutSec?: number }` |
| `docker.restart` | `{ id: string, timeoutSec?: number }` |
| `docker.pull` | `{ image: string, auth?: { username, password, serveraddress } }` |
| `docker.recreate` | `{ id: string, image?: string, desiredDigest?: string }` |
| `docker.compose` | `{ action: "up"\|"down", projectPath: string, image?: string }` — `projectPath` must exist (file or dir with compose.yaml); `~` expanded |
| `docker.compose.apply` | `{ projectName, yaml, env?, registryAuths?, action?: "up"\|"down" }` → writes under compose root, returns `projectPath` |
| `docker.compose.status` | `{ projectName }` → `{ exists, projectPath?, services? }` |
| `image.digest` | `{ image: string, auth?: ... }` → remote registry digest |
| `image.runningDigest` | `{ id: string }` → digests of the image the container is running |
| `image.checkUpdate` | `{ id|containerId, image, auth? }` → `{ updateAvailable, remoteDigest, localDigests }` |
| `image.listTags` | `{ imageRepo, auth? }` → `{ tags: string[] }` |
| `image.listLocal` | `{}` → `{ images: [{ repository, tag, repoTag }] }` |
| `inventory.disk` | `{}` |
| `agent.config` | `{ metricsIntervalSec, metricsRetentionHours }` — sampling interval; retention applied on server |

## Events (agent → server)

| type | payload |
|------|---------|
| `hello` | `{ agentName, protocolVersion, agentVersion, transport, hostname? }` |
| `heartbeat` | `{ ts, containers?: number }` |
| `command.result` | `{ requestId, ok, data?, error? }` |
| `stream.log` | `{ requestId, line }` |
| `inventory` | `{ diskUsedBytes?, diskTotalBytes?, danglingImages? }` |
| `metrics.batch` | `{ ts, containers: [{ id, name, image, state, status, cpuPercent, memoryUsageBytes, memoryLimitBytes, sizeRwBytes, sizeRootFsBytes }] }` |

## Envelope

```json
{
  "requestId": "uuid",
  "type": "docker.list",
  "payload": {}
}
```
