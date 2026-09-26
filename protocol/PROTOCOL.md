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
| `docker.list` | `{ all?: boolean }` |
| `docker.inspect` | `{ id: string }` |
| `docker.pull` | `{ image: string, auth?: { username, password, serveraddress } }` |
| `docker.recreate` | `{ id: string, image?: string, desiredDigest?: string }` — pins `repo@sha256:…` only when the tag no longer resolves to that digest (rollback); otherwise creates with `name:tag` |
| `docker.compose` | `{ action: "up"\|"down", projectPath: string, image?: string, forceRecreate?: boolean }` |
| `docker.compose.apply` | `{ projectName, yaml, env?, registryAuths?, action?: "up"\|"down", forceRecreate?: boolean }` — `forceRecreate` → `--force-recreate` so `:latest` updates apply after digest-pinned rollbacks |
| `docker.compose.status` | `{ projectName }` → `{ exists, services? }` |
| `image.digest` | `{ image: string, auth?: ... }` → remote registry digest |
| `image.runningDigest` | `{ id: string }` → digests of the image the container is running |
| `image.checkUpdate` | `{ id|containerId, image, auth? }` → `{ updateAvailable, remoteDigest, localDigests }` |
| `image.listTags` | `{ imageRepo, auth? }` → `{ tags: string[] }` |
| `image.listLocal` | `{}` → `{ images: [{ repository, tag, repoTag }] }` |
| `inventory.disk` | `{}` |

## Events (agent → server)

| type | payload |
|------|---------|
| `hello` | `{ agentName, protocolVersion, agentVersion, transport, hostname? }` |
| `heartbeat` | `{ ts, containers?: number }` |
| `command.result` | `{ requestId, ok, data?, error? }` |
| `stream.log` | `{ requestId, line }` |
| `inventory` | `{ diskUsedBytes?, diskTotalBytes?, danglingImages? }` |

## Envelope

```json
{
  "requestId": "uuid",
  "type": "docker.list",
  "payload": {}
}
```
