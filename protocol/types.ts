/** Canonical agent ↔ server protocol (transport-agnostic). */

export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

export type AgentTransport = 'ws' | 'grpc';

export type CommandType =
  | 'docker.list'
  | 'docker.inspect'
  | 'docker.stats'
  | 'docker.start'
  | 'docker.stop'
  | 'docker.restart'
  | 'docker.pull'
  | 'docker.recreate'
  | 'docker.compose'
  | 'docker.compose.apply'
  | 'docker.compose.status'
  | 'docker.compose.discover'
  | 'image.digest'
  | 'image.runningDigest'
  | 'image.checkUpdate'
  | 'image.listTags'
  | 'image.listLocal'
  | 'inventory.disk'
  | 'agent.config';

export type EventType =
  | 'hello'
  | 'heartbeat'
  | 'command.result'
  | 'stream.log'
  | 'inventory'
  | 'metrics.batch';

export interface AgentConfigPayload {
  metricsIntervalSec: number;
  metricsRetentionHours: number;
}

export interface MetricsBatchPayload {
  ts: number;
  containers: Array<{
    id: string;
    name: string;
    image?: string;
    state?: string;
    status?: string;
    cpuPercent?: number | null;
    memoryUsageBytes?: number | null;
    memoryLimitBytes?: number | null;
    sizeRwBytes?: number | null;
    sizeRootFsBytes?: number | null;
  }>;
}

export interface Envelope<T = unknown> {
  requestId: string;
  type: string;
  payload: T;
}

export interface HelloPayload {
  agentName: string;
  protocolVersion: number;
  agentVersion: string;
  transport: AgentTransport;
  hostname?: string;
}

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress?: string;
}

export interface DockerRecreatePayload {
  id: string;
  image?: string;
  desiredDigest?: string;
}

export interface CommandResultPayload {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
