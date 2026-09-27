import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Envelope } from '../../protocol/types.js';
import logger from '../logger.js';
import { reconnectDelayMs, sleep } from './reconnect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type GrpcOpts = {
  address: string;
  token: string;
  agentName: string;
  hello: Envelope;
  onCommand: (env: Envelope, reply: (env: Envelope) => void) => Promise<void>;
  onReady: (send: (env: Envelope) => void) => void;
  onDisconnected?: () => void;
};

function resolveProtoPath(): string {
  const candidates = [
    // Docker / production: protocol copied next to cwd (`/app/protocol`)
    path.join(process.cwd(), 'protocol', 'agent.proto'),
    // `pnpm dev` / tsx: src/transport → ../../protocol
    path.join(__dirname, '../../protocol/agent.proto'),
    // Compiled: dist/src/transport → ../../../protocol
    path.join(__dirname, '../../../protocol/agent.proto'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `agent.proto not found (tried: ${candidates.join(', ')})`,
  );
}

function loadClient(address: string) {
  const protoPath = resolveProtoPath();
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as grpc.GrpcObject;
  const agentPkg = proto.sentrydock as grpc.GrpcObject;
  const agentV1 = agentPkg.agent as grpc.GrpcObject;
  const v1 = agentV1.v1 as grpc.GrpcObject;
  const Client = v1.AgentService as grpc.ServiceClientConstructor;
  return new Client(address, grpc.credentials.createInsecure(), {
    'grpc.keepalive_time_ms': 15_000,
    'grpc.keepalive_timeout_ms': 5_000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.http2.max_pings_without_data': 0,
  });
}

function openSession(
  client: any,
  opts: GrpcOpts,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const meta = new grpc.Metadata();
    meta.set('authorization', `Bearer ${opts.token}`);
    meta.set('agent-name', opts.agentName);
    meta.set('protocol-version', '1');

    const call = client.Connect(meta) as grpc.ClientDuplexStream<
      { request_id: string; type: string; payload_json: string },
      { request_id: string; type: string; payload_json: string }
    >;
    let settled = false;
    let ready = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        call.cancel();
      } catch {
        /* ignore */
      }
      opts.onDisconnected?.();
      if (err && !ready) reject(err);
      else {
        if (err) logger.warn('gRPC session ended with error', { err: err.message });
        resolve();
      }
    };

    const send = (env: Envelope) => {
      if (settled) return;
      try {
        call.write({
          request_id: env.requestId,
          type: env.type,
          payload_json: JSON.stringify(env.payload ?? {}),
        });
      } catch (e) {
        logger.warn('gRPC write failed', { err: e instanceof Error ? e.message : String(e) });
      }
    };

    call.on('data', (msg: { request_id: string; type: string; payload_json: string }) => {
      const env: Envelope = {
        requestId: msg.request_id,
        type: msg.type,
        payload: JSON.parse(msg.payload_json || '{}'),
      };
      void opts.onCommand(env, send);
    });

    call.on('error', (err: Error & { code?: number; details?: string }) => {
      logger.error('gRPC error', {
        err: err.message,
        code: err.code,
        details: err.details,
      });
      finish(err);
    });

    call.on('end', () => {
      logger.warn('gRPC stream ended');
      finish();
    });

    // Brief wait so UNAUTHENTICATED from the server surfaces before we claim ready
    const timer = setTimeout(() => {
      if (settled) return;
      ready = true;
      send(opts.hello);
      opts.onReady(send);
      logger.info('gRPC connected; hello sent');
    }, 500);
  });
}

/** Connects over gRPC and reconnects forever with backoff when the stream drops. */
export async function connectGrpc(opts: GrpcOpts): Promise<never> {
  const client = loadClient(opts.address);
  let attempt = 0;

  for (;;) {
    attempt += 1;
    if (attempt === 1) {
      logger.info(`Connecting gRPC to ${opts.address}`);
    } else {
      logger.info(`Reconnecting gRPC to ${opts.address}`, { attempt });
    }

    try {
      await openSession(client, opts);
      attempt = 0;
    } catch (err) {
      const code = (err as { code?: number })?.code;
      logger.error('gRPC connect failed', {
        err: err instanceof Error ? err.message : String(err),
        code,
      });
      // Wrong token — keep retrying slowly in case the registry was briefly unavailable
      if (code === grpc.status.UNAUTHENTICATED) {
        logger.error('gRPC unauthorized — check AGENT_TOKEN; retrying slowly');
        await sleep(15_000);
        continue;
      }
    }

    const delay = reconnectDelayMs(Math.max(attempt, 1));
    logger.info(`gRPC reconnect in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}
