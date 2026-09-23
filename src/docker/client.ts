import fs from 'fs';
import os from 'os';
import path from 'path';
import Docker from 'dockerode';
import logger from '../logger.js';

function hostToSocket(host: string): string | null {
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  return null;
}

/** Resolve the same engine the local `docker` CLI would use (Docker Desktop, rootless, etc.). */
export function resolveDockerSocket(): string {
  if (process.env.DOCKER_HOST) {
    const fromHost = hostToSocket(process.env.DOCKER_HOST);
    if (fromHost) return fromHost;
  }

  if (process.env.DOCKER_SOCKET) {
    return process.env.DOCKER_SOCKET;
  }

  const fromContext = socketFromDockerContext();
  if (fromContext && fs.existsSync(fromContext)) return fromContext;

  const candidates = [
    path.join(os.homedir(), '.docker/desktop/docker.sock'),
    path.join(os.homedir(), '.docker/run/docker.sock'),
    '/var/run/docker.sock',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '/var/run/docker.sock';
}

function socketFromDockerContext(): string | null {
  try {
    const cfgPath = path.join(os.homedir(), '.docker/config.json');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { currentContext?: string };
    const name = cfg.currentContext;
    if (!name || name === 'default') return null;

    const metaRoot = path.join(os.homedir(), '.docker/contexts/meta');
    if (!fs.existsSync(metaRoot)) return null;
    for (const dir of fs.readdirSync(metaRoot)) {
      const metaPath = path.join(metaRoot, dir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        Name?: string;
        Endpoints?: { docker?: { Host?: string } };
      };
      if (meta.Name !== name) continue;
      const host = meta.Endpoints?.docker?.Host;
      if (!host) return null;
      return hostToSocket(host);
    }
  } catch (err) {
    logger.warn('could not read docker context', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

export function createDocker() {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) {
    logger.info('Docker via DOCKER_HOST', { host: process.env.DOCKER_HOST });
    return new Docker();
  }

  const socketPath = resolveDockerSocket();
  logger.info('Docker socket', { socketPath });
  return new Docker({ socketPath });
}
