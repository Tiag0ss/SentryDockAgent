import dotenv from 'dotenv';
import os from 'os';
import { createDocker } from './docker/client.js';
import { handleCommand } from './docker/commands.js';
import { connectWs } from './transport/ws.js';
import { connectGrpc } from './transport/grpc.js';
import logger from './logger.js';
import type { Envelope } from '../protocol/types.js';
import { PROTOCOL_VERSION } from '../protocol/types.js';

dotenv.config();

const AGENT_VERSION = process.env.AGENT_VERSION || '0.1.0';
const transport = (process.env.AGENT_TRANSPORT || 'ws') as 'ws' | 'grpc';
const url = process.env.SENTRYDOCK_URL || 'http://localhost:3000';
const token = process.env.AGENT_TOKEN || '';
const agentName = process.env.AGENT_NAME || os.hostname();

if (!token) {
  logger.error('AGENT_TOKEN is required');
  process.exit(1);
}

const docker = createDocker();

/** Latest transport send — updated on (re)connect; heartbeats use this ref. */
let sendFn: ((env: Envelope) => void) | null = null;
let heartbeatsStarted = false;

async function onCommand(env: Envelope, reply: (env: Envelope) => void) {
  try {
    const data = await handleCommand(docker, env.type, env.payload);
    reply({
      requestId: env.requestId,
      type: 'command.result',
      payload: { requestId: env.requestId, ok: true, data },
    });
  } catch (e) {
    reply({
      requestId: env.requestId,
      type: 'command.result',
      payload: {
        requestId: env.requestId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
    });
  }
}

function onReady(send: (e: Envelope) => void) {
  sendFn = send;
  if (heartbeatsStarted) return;
  heartbeatsStarted = true;

  setInterval(() => {
    if (!sendFn) return;
    void (async () => {
      let containers: number | undefined;
      try {
        const list = await handleCommand(docker, 'docker.list', { all: false }) as unknown[];
        containers = Array.isArray(list) ? list.length : undefined;
      } catch {
        /* ignore */
      }
      sendFn!({
        requestId: `hb-${Date.now()}`,
        type: 'heartbeat',
        payload: { ts: Date.now(), ...(containers != null ? { containers } : {}) },
      });
    })();
  }, 15_000);

  setInterval(async () => {
    if (!sendFn) return;
    try {
      const inv = await handleCommand(docker, 'inventory.disk', {});
      sendFn({
        requestId: `inv-${Date.now()}`,
        type: 'inventory',
        payload: inv,
      });
    } catch (err) {
      logger.warn('inventory.disk failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }, 60_000);
}

function onDisconnected() {
  sendFn = null;
}

async function main() {
  const hello: Envelope = {
    requestId: 'hello',
    type: 'hello',
    payload: {
      agentName,
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      transport,
      hostname: os.hostname(),
    },
  };

  if (transport === 'grpc') {
    const grpcUrl = process.env.SENTRYDOCK_GRPC_URL || url.replace(/^https?:\/\//, '').replace(/:\d+$/, '') + ':50051';
    await connectGrpc({
      address: grpcUrl,
      token,
      agentName,
      hello,
      onCommand,
      onReady,
      onDisconnected,
    });
  } else {
    await connectWs({
      url,
      token,
      agentName,
      hello,
      onCommand,
      onReady,
      onDisconnected,
    });
  }
}

main().catch((err) => {
  logger.error('Fatal', { err });
  process.exit(1);
});
