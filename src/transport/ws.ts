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
}) {
  const socket: Socket = io(`${opts.url}/agents`, {
    transports: ['websocket'],
    auth: {
      token: opts.token,
      agentName: opts.agentName,
    },
    reconnection: true,
  });

  const send = (env: Envelope) => {
    socket.emit('event', env);
  };

  socket.on('connect', () => {
    logger.info('Connected via WebSocket');
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
  });
}
