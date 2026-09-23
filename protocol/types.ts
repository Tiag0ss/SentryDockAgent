/** Canonical agent ↔ server protocol (transport-agnostic). */

export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

export type AgentTransport = 'ws' | 'grpc';

export type CommandType =
  | 'docker.list'
  | 'docker.inspect'
  | 'docker.pull'
  | 'docker.recreate'
  | 'docker.compose'
  | 'image.digest'
  | 'inventory.disk';

export type EventType =
  | 'hello'
  | 'heartbeat'
  | 'command.result'
  | 'stream.log'
  | 'inventory';

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
