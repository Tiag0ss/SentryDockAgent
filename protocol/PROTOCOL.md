# SentryDock Agent Protocol

Canonical contract between control plane and agents. Transports: **WebSocket (Socket.IO)** or **gRPC**. Both map to the same messages.

## Versions

- `protocolVersion`: `1`
- Agents send `agentVersion` + `protocolVersion` on `hello`.
- Control plane rejects agents below `MIN_PROTOCOL_VERSION` (default `1`).

## Auth

Outbound connection from agent with token:

- WS: `auth: { token, agentName, transport: "ws" }`
- gRPC: metadata `authorization: Bearer <token>`, `agent-name`, `protocol-version`

## Commands (server → agent)

| type | payload |
|------|---------|
| `docker.list` | `{ all?: boolean }` |
| `docker.inspect` | `{ id: string }` |
| `docker.pull` | `{ image: string, auth?: { username, password, serveraddress } }` |
| `docker.recreate` | `{ id: string, image?: string, desiredDigest?: string }` |
| `docker.compose` | `{ action: "up"\|"down", projectPath: string }` |
| `image.digest` | `{ image: string, auth?: ... }` → remote registry digest |
| `image.runningDigest` | `{ id: string }` → digests of the image the container is running |
| `image.checkUpdate` | `{ id|containerId, image, auth? }` → `{ updateAvailable, remoteDigest, localDigests }` |
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
