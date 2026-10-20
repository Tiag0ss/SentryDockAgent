import dotenv from 'dotenv';
import os from 'os';
import { createDocker } from './docker/client.js';
import { handleCommand } from './docker/commands.js';
import { connectWs } from './transport/ws.js';
import { connectGrpc } from './transport/grpc.js';
import logger from './logger.js';
import type { AgentConfigPayload, Envelope, MetricsBatchPayload } from '../protocol/types.js';
import { PROTOCOL_VERSION } from '../protocol/types.js';

dotenv.config();

const AGENT_VERSION = process.env.AGENT_VERSION || '0.1.0';
const transport = (process.env.AGENT_TRANSPORT || 'ws') as 'ws' | 'grpc';
const url = process.env.SENTRYDOCK_URL || 'http://localhost:3000';
const token = process.env.AGENT_TOKEN || '';
/** Display label only — authentication is by AGENT_TOKEN. */
const agentName = process.env.AGENT_NAME || os.hostname();

const DEFAULT_METRICS_INTERVAL_SEC = 30;
const MIN_METRICS_INTERVAL_SEC = 10;
const MAX_METRICS_INTERVAL_SEC = 300;

if (!token) {
  logger.error('AGENT_TOKEN is required');
  process.exit(1);
}

const docker = createDocker();

/** Latest transport send — updated on (re)connect; heartbeats use this ref. */
let sendFn: ((env: Envelope) => void) | null = null;
let heartbeatsStarted = false;

let metricsIntervalSec = DEFAULT_METRICS_INTERVAL_SEC;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let metricsBusy = false;

function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_METRICS_INTERVAL_SEC;
  return Math.min(MAX_METRICS_INTERVAL_SEC, Math.max(MIN_METRICS_INTERVAL_SEC, Math.round(n)));
}

function applyAgentConfig(payload: unknown): AgentConfigPayload {
  const p = (payload || {}) as Partial<AgentConfigPayload>;
  metricsIntervalSec = clampInterval(Number(p.metricsIntervalSec));
  const retention = Number(p.metricsRetentionHours);
  restartMetricsLoop();
  logger.info('agent.config applied', {
    metricsIntervalSec,
    metricsRetentionHours: Number.isFinite(retention) ? retention : undefined,
  });
  return {
    metricsIntervalSec,
    metricsRetentionHours: Number.isFinite(retention) ? Math.round(retention) : 24,
  };
}

async function sampleAndSendMetrics() {
  if (!sendFn || metricsBusy) return;
  metricsBusy = true;
  try {
    const list = await handleCommand(docker, 'docker.list', { all: true, withStats: true }) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return;
    const containers: MetricsBatchPayload['containers'] = list.map((c) => {
      const stats = (c.stats && typeof c.stats === 'object') ? c.stats as Record<string, unknown> : null;
      return {
        id: String(c.id || ''),
        name: String(c.name || c.id || ''),
        image: c.image != null ? String(c.image) : undefined,
        state: c.state != null ? String(c.state) : undefined,
        status: c.status != null ? String(c.status) : undefined,
        cpuPercent: stats?.cpuPercent != null ? Number(stats.cpuPercent) : null,
        memoryUsageBytes: stats?.memoryUsageBytes != null ? Number(stats.memoryUsageBytes) : null,
        memoryLimitBytes: stats?.memoryLimitBytes != null ? Number(stats.memoryLimitBytes) : null,
        sizeRwBytes: stats?.sizeRwBytes != null ? Number(stats.sizeRwBytes) : null,
        sizeRootFsBytes: stats?.sizeRootFsBytes != null ? Number(stats.sizeRootFsBytes) : null,
      };
    }).filter((c) => c.id);

    sendFn({
      requestId: `metrics-${Date.now()}`,
      type: 'metrics.batch',
      payload: { ts: Date.now(), containers } satisfies MetricsBatchPayload,
    });
  } catch (err) {
    logger.warn('metrics sample failed', { err: err instanceof Error ? err.message : String(err) });
  } finally {
    metricsBusy = false;
  }
}

function restartMetricsLoop() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  metricsTimer = setInterval(() => {
    void sampleAndSendMetrics();
  }, metricsIntervalSec * 1000);
  // Sample soon after (re)config / connect
  void sampleAndSendMetrics();
}

async function onCommand(env: Envelope, reply: (env: Envelope) => void) {
  try {
    if (env.type === 'agent.config') {
      const data = applyAgentConfig(env.payload);
      reply({
        requestId: env.requestId,
        type: 'command.result',
        payload: { requestId: env.requestId, ok: true, data },
      });
      return;
    }
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
  if (!metricsTimer) restartMetricsLoop();

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
