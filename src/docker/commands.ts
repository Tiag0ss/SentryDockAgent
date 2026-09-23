import type Docker from 'dockerode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import logger from '../logger.js';

const execFileAsync = promisify(execFile);

type RegistryAuth = { username: string; password: string; serveraddress?: string };

function primaryContainerName(names: string[] | undefined, id: string): string {
  const cleaned = (names || []).map((n) => n.replace(/^\//, '')).filter(Boolean);
  // Link aliases look like "other/name"; prefer plain names
  const plain = cleaned.filter((n) => !n.includes('/'));
  const pool = plain.length ? plain : cleaned;
  if (!pool.length) return id.slice(0, 12);
  return pool.sort((a, b) => a.length - b.length)[0];
}

function displayImage(image: string | undefined, imageId?: string): string {
  if (image && !image.startsWith('sha256:')) return image;
  if (imageId) return imageId.replace(/^sha256:/, '').slice(0, 12);
  if (image) return image.replace(/^sha256:/, '').slice(0, 12);
  return 'unknown';
}

export async function handleCommand(docker: Docker, type: string, payload: unknown): Promise<unknown> {
  const p = (payload || {}) as Record<string, unknown>;

  switch (type) {
    case 'docker.list': {
      const all = p.all === undefined ? true : Boolean(p.all);
      const containers = await docker.listContainers({ all });
      return containers.map((c) => {
        const names = (c.Names || []).map((n) => n.replace(/^\//, ''));
        const name = primaryContainerName(c.Names, c.Id);
        const labels = c.Labels || {};
        const composeProject = labels['com.docker.compose.project'];
        const composeService = labels['com.docker.compose.service'];
        return {
          id: c.Id,
          name,
          names,
          image: displayImage(c.Image, c.ImageID),
          imageRaw: c.Image,
          imageId: c.ImageID,
          state: c.State,
          status: c.Status,
          created: c.Created,
          labels,
          composeProject: composeProject || null,
          composeService: composeService || null,
        };
      });
    }
    case 'docker.inspect': {
      const id = String(p.id);
      const c = docker.getContainer(id);
      return c.inspect();
    }
    case 'docker.pull': {
      const image = String(p.image);
      const auth = p.auth as RegistryAuth | undefined;
      await pullImage(docker, image, auth);
      return { pulled: image };
    }
    case 'image.digest': {
      const image = String(p.image);
      const auth = p.auth as RegistryAuth | undefined;
      // Prefer local inspect after distribution resolve via pull dry - use distribution inspect if available
      try {
        const img = docker.getImage(image);
        const insp = await img.inspect();
        const digest = insp.RepoDigests?.[0] || insp.Id;
        return { digest, id: insp.Id };
      } catch {
        // local image missing — pull then re-inspect
        await pullImage(docker, image, auth);
        const img = docker.getImage(image);
        const insp = await img.inspect();
        return { digest: insp.RepoDigests?.[0] || insp.Id, id: insp.Id };
      }
    }
    case 'docker.recreate': {
      const id = String(p.id);
      const desiredDigest = p.desiredDigest ? String(p.desiredDigest) : undefined;
      const image = p.image ? String(p.image) : undefined;
      const container = docker.getContainer(id);
      const insp = await container.inspect();

      // Idempotency: if already on desired digest / image, skip kill
      if (desiredDigest) {
        const current = insp.Image || '';
        const short = desiredDigest.replace(/^sha256:/, '');
        if (current.includes(short) || current === desiredDigest) {
          return { skipped: true, reason: 'already_desired_digest' };
        }
      }

      const name = insp.Name.replace(/^\//, '');
      const config = insp.Config;
      const hostConfig = insp.HostConfig;
      const networking = insp.NetworkSettings?.Networks;

      await container.stop({ t: 10 }).catch(() => undefined);
      await container.remove({ force: true });

      const createOpts: Docker.ContainerCreateOptions = {
        name,
        Image: image || config.Image,
        Env: config.Env,
        Cmd: config.Cmd,
        Entrypoint: config.Entrypoint,
        Labels: config.Labels,
        ExposedPorts: config.ExposedPorts,
        HostConfig: hostConfig || undefined,
        NetworkingConfig: networking
          ? { EndpointsConfig: networking }
          : undefined,
      };

      const created = await docker.createContainer(createOpts);
      await created.start();
      return { id: created.id, recreated: true };
    }
    case 'docker.compose': {
      const action = String(p.action);
      const projectPath = String(p.projectPath);
      await execFileAsync('docker', ['compose', action, '-d'].filter((x, i) => !(action === 'down' && x === '-d')), {
        cwd: projectPath,
      });
      return { ok: true, action };
    }
    case 'inventory.disk': {
      try {
        const images = await docker.listImages({ filters: { dangling: ['true'] } });
        let diskUsedBytes = 0;
        let diskTotalBytes = 0;
        try {
          const stat = fs.statfsSync('/');
          diskTotalBytes = Number(stat.blocks) * Number(stat.bsize);
          diskUsedBytes = (Number(stat.blocks) - Number(stat.bfree)) * Number(stat.bsize);
        } catch (err) {
          logger.warn('statfs unavailable', { err: err instanceof Error ? err.message : String(err) });
        }
        return {
          danglingImages: images.length,
          diskUsedBytes,
          diskTotalBytes,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    default:
      throw new Error(`Unknown command: ${type}`);
  }
}

function pullImage(docker: Docker, image: string, auth?: RegistryAuth): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(image, { authconfig: auth }, (err, stream) => {
      if (err || !stream) return reject(err || new Error('pull failed'));
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}
