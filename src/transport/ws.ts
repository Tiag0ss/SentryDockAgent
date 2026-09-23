import { io, Socket } from 'socket.io-client';
import type { Envelope } from '../../protocol/types.js';
import logger from '../logger.js';

export async function connectWs(opts: {
  url: string;
  token: string;
  agentName: string;
  hello: Envelope;
  onCommand: (env: Envelope, reply: (env: Envelope) => void) => Promise<void>;
  onReady: (send: (env: Envelope) => void) => void;
  onDisconnected?: () => void;
}): Promise<void> {
  const socket: Socket = io(`${opts.url}/agents`, {
    transports: ['websocket'],
    auth: {
      token: opts.token,
      agentName: opts.agentName,
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.4,
    timeout: 20_000,
  });

  const send = (env: Envelope) => {
    if (!socket.connected) return;
    socket.emit('event', env);
  };

  socket.on('connect', () => {
    logger.info(socket.recovered ? 'WebSocket recovered' : 'Connected via WebSocket');
    send(opts.hello);
    opts.onReady(send);
  });

  socket.on('command', (env: Envelope) => {
    void opts.onCommand(env, send);
  });

  socket.on('connect_error', (err) => {
    logger.error('WS connect error', { err: err.message });
  });

  socket.on('disconnect', (reason) => {
    logger.warn('WS disconnected', { reason });
    opts.onDisconnected?.();
  });

  socket.io.on('reconnect_attempt', (n) => {
    logger.info('WS reconnect attempt', { attempt: n });
  });

  socket.io.on('reconnect_failed', () => {
    logger.error('WS reconnect failed');
  });
}
