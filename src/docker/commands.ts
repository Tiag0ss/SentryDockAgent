import Docker from 'dockerode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandType, DockerRecreatePayload, RegistryAuth } from '../../protocol/types.js';
import logger from '../logger.js';

const execFileAsync = promisify(execFile);

function asAuth(auth?: RegistryAuth): Docker.AuthConfig | undefined {
  if (!auth?.username) return undefined;
  return {
    username: auth.username,
    password: auth.password,
    serveraddress: auth.serveraddress || 'https://index.docker.io/v1/',
  };
}

function registryAuthHeader(auth?: RegistryAuth): string | undefined {
  if (!auth?.username) return undefined;
  return Buffer.from(
    JSON.stringify({
      username: auth.username,
      password: auth.password,
      serveraddress: auth.serveraddress || 'https://index.docker.io/v1/',
    }),
  ).toString('base64');
}

function normalizeDigest(value: string | undefined | null): string | null {
  if (!value) return null;
  const m = String(value).match(/sha256:[a-f0-9]{64}/i);
  return m ? m[0].toLowerCase() : null;
}

/** Extract sha256 digests from RepoDigests like `repo@sha256:...`. */
function digestsFromRepoDigests(repoDigests: string[] | undefined): string[] {
  if (!repoDigests?.length) return [];
  return repoDigests
    .map((d) => normalizeDigest(d))
    .filter((d): d is string => Boolean(d));
}

function dialJson(
  docker: Docker,
  opts: { path: string; method?: string; auth?: RegistryAuth },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const authHeader = registryAuthHeader(opts.auth);
    if (authHeader) headers['X-Registry-Auth'] = authHeader;

    docker.modem.dial(
      {
        path: opts.path,
        method: opts.method || 'GET',
        headers,
        statusCodes: {
          200: true,
          204: true,
          400: false,
          401: false,
          403: false,
          404: false,
          500: false,
        },
      },
      (err: Error | null, data: unknown) => {
        if (err) reject(err);
        else resolve((data || {}) as Record<string, unknown>);
      },
    );
  });
}

type RemoteDigests = { primary: string; candidates: string[]; source: string };

function uniqueDigests(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeDigest(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Resolve remote image digests without relying on a local pull.
 * Returns the index/manifest digest plus platform candidates (multi-arch safe).
 */
async function getRemoteDigests(
  docker: Docker,
  image: string,
  auth?: RegistryAuth,
): Promise<RemoteDigests> {
  try {
    const data = await dialJson(docker, {
      path: `/distribution/${image}/json`,
      auth,
    });
    const descriptor = data.Descriptor as { digest?: string } | undefined;
    const platforms = (data.Platforms as Array<{ digest?: string }> | undefined) || [];
    const candidates = uniqueDigests([
      descriptor?.digest,
      ...platforms.map((p) => p.digest),
    ]);
    if (candidates[0]) {
      return { primary: candidates[0], candidates, source: 'distribution' };
    }
  } catch (err) {
    logger.debug('distribution inspect failed', { err, image });
  }

  try {
    const { stdout } = await execFileAsync('docker', ['manifest', 'inspect', image], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const j = JSON.parse(stdout) as {
      config?: { digest?: string };
      Descriptor?: { digest?: string };
      digest?: string;
      manifests?: Array<{ digest?: string; platform?: { architecture?: string; os?: string } }>;
    };
    const candidates = uniqueDigests([
      j.Descriptor?.digest,
      j.digest,
      j.config?.digest,
      ...(j.manifests || []).map((m) => m.digest),
    ]);
    if (candidates[0]) {
      return { primary: candidates[0], candidates, source: 'manifest' };
    }
  } catch (err) {
    logger.debug('manifest inspect failed', { err, image });
  }

  // Last resort: local RepoDigests for the tag (may be stale)
  try {
    const insp = await docker.getImage(image).inspect();
    const local = digestsFromRepoDigests(insp.RepoDigests);
    const id = normalizeDigest(insp.Id);
    const candidates = uniqueDigests([...local, id]);
    if (candidates[0]) {
      return { primary: candidates[0], candidates, source: 'local-repodigest' };
    }
  } catch {
    /* ignore */
  }

  throw new Error(`Could not resolve remote digest for ${image}`);
}

async function getRunningImageDigests(
  docker: Docker,
  containerId: string,
): Promise<{
  imageId: string;
  configImage: string;
  digests: string[];
  repoDigests: string[];
}> {
  const c = await docker.getContainer(containerId).inspect();
  const imageId = String(c.Image || '');
  const configImage = String(c.Config?.Image || '');
  let repoDigests: string[] = [];
  let digests: string[] = [];
  try {
    const img = await docker.getImage(imageId).inspect();
    repoDigests = img.RepoDigests || [];
    digests = digestsFromRepoDigests(repoDigests);
    const idDigest = normalizeDigest(img.Id);
    if (idDigest && !digests.includes(idDigest)) digests.push(idDigest);
  } catch (err) {
    logger.warn('could not inspect running image', { err, imageId });
  }
  return { imageId, configImage, digests, repoDigests };
}

async function pullImage(docker: Docker, image: string, auth?: RegistryAuth): Promise<void> {
  const authconfig = asAuth(auth);
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, authconfig ? { authconfig } : {}, (err, stream) => {
      if (err || !stream) return reject(err || new Error('pull failed'));
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}

/**
 * Authoritative update check for Docker Desktop / containerd image store:
 * RepoDigests often equal the image config id (not the registry index digest),
 * so comparing them to the remote manifest digest always looks like an update.
 * Instead: refresh the tag with a pull and compare the running image Id to the tag Id.
 */
async function checkImageUpdate(
  docker: Docker,
  containerId: string,
  image: string,
  auth?: RegistryAuth,
): Promise<{
  updateAvailable: boolean;
  remoteDigest: string;
  remoteDigests: string[];
  remoteSource: string;
  localDigests: string[];
  imageId: string;
  configImage: string;
  image: string;
}> {
  const running = await getRunningImageDigests(docker, containerId);
  const beforeId = running.imageId;

  await pullImage(docker, image, auth);

  const latest = await docker.getImage(image).inspect();
  const latestId = String(latest.Id || '');
  const repoDigests = digestsFromRepoDigests(latest.RepoDigests);

  const updateAvailable = Boolean(beforeId && latestId && beforeId !== latestId);

  logger.info('image.checkUpdate', {
    image,
    containerId,
    beforeId,
    latestId,
    updateAvailable,
    repoDigests,
  });

  return {
    updateAvailable,
    remoteDigest: latestId,
    remoteDigests: repoDigests.length ? repoDigests : [latestId],
    remoteSource: 'pull-compare',
    localDigests: beforeId ? [beforeId] : [],
    imageId: beforeId,
    configImage: running.configImage,
    image,
  };
}

export async function handleCommand(
  docker: Docker,
  type: string,
  payload: unknown,
): Promise<unknown> {
  const p = (payload || {}) as Record<string, unknown>;
  switch (type as CommandType) {
      case 'docker.list': {
        const containers = await docker.listContainers({ all: Boolean(p.all ?? true) });
        return containers.map((c) => ({
          id: c.Id,
          names: c.Names,
          image: c.Image,
          imageId: c.ImageID,
          state: c.State,
          status: c.Status,
        }));
      }
      case 'docker.inspect': {
        const id = String(p.id);
        return docker.getContainer(id).inspect();
      }
      case 'docker.pull': {
        const image = String(p.image);
        await pullImage(docker, image, p.auth as RegistryAuth | undefined);
        return { pulled: image };
      }
      case 'docker.recreate': {
        const { id, image } = p as unknown as DockerRecreatePayload;
        const container = docker.getContainer(id);
        const info = await container.inspect();
        const name = info.Name.replace(/^\//, '');
        const wasRunning = info.State.Running;
        // Prefer explicit image / Config.Image (tag) so we pick up the freshly pulled tag
        const imageRef = image || info.Config.Image || info.Image;

        // Strip fields that Docker rejects when re-creating from an inspect dump
        const hostConfig = { ...(info.HostConfig || {}) } as Record<string, unknown>;
        delete hostConfig.ContainerIDFile;
        // Normalize nulls that createContainer dislikes
        if (hostConfig.RestartPolicy && typeof hostConfig.RestartPolicy === 'object') {
          const rp = hostConfig.RestartPolicy as { Name?: string; MaximumRetryCount?: number };
          if (!rp.Name) hostConfig.RestartPolicy = { Name: 'no', MaximumRetryCount: 0 };
        }

        const endpoints = info.NetworkSettings?.Networks || {};
        const networkingConfig = {
          EndpointsConfig: Object.fromEntries(
            Object.entries(endpoints).map(([net, cfg]) => {
              const c = (cfg || {}) as Record<string, unknown>;
              return [
                net,
                {
                  Aliases: c.Aliases,
                  DriverOpts: c.DriverOpts,
                  IPAMConfig: c.IPAMConfig,
                  Links: c.Links,
                },
              ];
            }),
          ),
        };

        if (wasRunning) {
          try {
            await container.stop({ t: 20 });
          } catch (err) {
            logger.warn('stop before recreate failed (continuing)', {
              err: err instanceof Error ? err.message : String(err),
              name,
            });
          }
        }
        await container.remove({ force: true });

        const created = await docker.createContainer({
          name,
          Image: imageRef,
          Env: info.Config.Env,
          Cmd: info.Config.Cmd ?? undefined,
          Entrypoint: info.Config.Entrypoint ?? undefined,
          WorkingDir: info.Config.WorkingDir || undefined,
          User: info.Config.User || undefined,
          Labels: info.Config.Labels,
          ExposedPorts: info.Config.ExposedPorts,
          Volumes: info.Config.Volumes,
          HostConfig: hostConfig as Docker.ContainerCreateOptions['HostConfig'],
          NetworkingConfig: networkingConfig,
        });
        if (wasRunning) await created.start();
        const after = await created.inspect();
        logger.info('docker.recreate done', {
          name,
          imageRef,
          newId: created.id,
          newImage: after.Image,
        });
        return {
          id: created.id,
          name,
          image: imageRef,
          imageId: after.Image,
          startedAt: after.State?.StartedAt,
        };
      }
      case 'docker.compose': {
        const action = String(p.action) as 'up' | 'down';
        const projectPath = String(p.projectPath || '').trim();
        if (!projectPath) {
          throw new Error(
            'docker.compose requires projectPath (path to docker-compose.yml). For standalone containers use recreate_container instead.',
          );
        }
        const args =
          action === 'up'
            ? ['compose', '-f', projectPath, 'up', '-d', '--pull', 'always']
            : ['compose', '-f', projectPath, 'down'];
        const { stdout, stderr } = await execFileAsync('docker', args, {
          timeout: 10 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr };
      }
      case 'image.digest': {
        const image = String(p.image);
        const auth = p.auth as RegistryAuth | undefined;
        const remote = await getRemoteDigests(docker, image, auth);
        return {
          digest: remote.primary,
          digests: remote.candidates,
          source: remote.source,
          image,
        };
      }
      case 'image.runningDigest': {
        const id = String(p.id);
        return getRunningImageDigests(docker, id);
      }
      case 'image.checkUpdate': {
        return checkImageUpdate(
          docker,
          String(p.containerId || p.id),
          String(p.image),
          p.auth as RegistryAuth | undefined,
        );
      }
      case 'inventory.disk': {
        const df = await docker.df();
        const images = (df.Images || []) as Array<{ Dangling?: boolean; SharedSize?: number }>;
        const dangling = images.filter((i) => i.Dangling).length;
        const layersSize = images.reduce((s, i) => s + (i.SharedSize || 0), 0);
        return {
          danglingImages: dangling,
          diskUsedBytes: layersSize,
          diskTotalBytes: null,
        };
      }
      default:
        throw new Error(`Unknown command: ${type}`);
    }
}
