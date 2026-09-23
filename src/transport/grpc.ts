import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Envelope } from '../../protocol/types.js';
import logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function connectGrpc(opts: {
  address: string;
  token: string;
  agentName: string;
  hello: Envelope;
  onCommand: (env: Envelope, reply: (env: Envelope) => void) => Promise<void>;
  onReady: (send: (env: Envelope) => void) => void;
}) {
  const protoPath = path.join(__dirname, '../../protocol/agent.proto');
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
  const client = new Client(opts.address, grpc.credentials.createInsecure());

  const meta = new grpc.Metadata();
  meta.set('authorization', `Bearer ${opts.token}`);
  meta.set('agent-name', opts.agentName);
  meta.set('protocol-version', '1');

  logger.info(`Connecting gRPC to ${opts.address}`);
  const call = client.Connect(meta);

  const send = (env: Envelope) => {
    call.write({
      request_id: env.requestId,
      type: env.type,
      payload_json: JSON.stringify(env.payload ?? {}),
    });
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
  });

  call.on('end', () => {
    logger.warn('gRPC stream ended');
  });

  // Brief wait so UNAUTHENTICATED from the server surfaces before we claim ready
  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => {
      clearTimeout(timer);
      call.removeListener('error', onErr);
      reject(err);
    };
    const onErr = (err: Error) => fail(err);
    call.once('error', onErr);
    const timer = setTimeout(() => {
      call.removeListener('error', onErr);
      resolve();
    }, 500);
  });

  send(opts.hello);
  opts.onReady(send);
  logger.info('gRPC connected; hello sent');
}
