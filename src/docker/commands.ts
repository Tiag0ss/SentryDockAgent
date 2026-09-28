import Docker from 'dockerode';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CommandType, DockerRecreatePayload, RegistryAuth } from '../../protocol/types.js';
import logger from '../logger.js';
import {
  normalizeDigest,
  isImageIdRef,
  pickRepoTag,
  pinImageToDigest,
  digestsFromRepoDigests,
} from './imageRef.js';

const execFileAsync = promisify(execFile);

const DOCKER_HUB_INDEX = 'https://index.docker.io/v1/';

/** Strip paste artifacts that break Docker Hub Basic auth. */
function sanitizeCredential(value: string): string {
  let s = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[\r\n\0]/g, '')
    .trim();
  // Accidental quotes from copy/paste into the secrets form.
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Normalize registry credentials so Docker Hub does not reject the Authorization header. */
function normalizeRegistryAuth(auth?: RegistryAuth | null): RegistryAuth | undefined {
  if (!auth) return undefined;
  let username = sanitizeCredential(String(auth.username ?? ''));
  let password = sanitizeCredential(String(auth.password ?? ''));
  // Accidental paste of "Bearer …" / "Basic …" into the password field.
  if (/^(bearer|basic)\s+/i.test(password)) {
    password = password.replace(/^(bearer|basic)\s+/i, '').trim();
  }
  if (!username || !password) return undefined;
  if (username.includes(':')) {
    logger.warn('registry username contains ":" — Docker Basic auth will fail', { username });
  }

  let serveraddress = sanitizeCredential(String(auth.serveraddress ?? ''));
  const isHub = !serveraddress
    || /^(docker\.io|index\.docker\.io|registry-1\.docker\.io|hub\.docker\.com)(:|\/|$)/i.test(serveraddress)
    || /^https?:\/\/(docker\.io|index\.docker\.io|registry-1\.docker\.io|hub\.docker\.com)\b/i.test(serveraddress);

  if (isHub) {
    // Hub usernames are lowercase; mixed case (e.g. TiagOss) breaks login/pull.
    username = username.toLowerCase();
    // CLI login expects "docker.io"; the index URL is for AuthConfig/API.
    serveraddress = DOCKER_HUB_INDEX;
  } else if (/^crg\.apkg\.io\b/i.test(serveraddress) || /^https?:\/\/crg\.apkg\.io\b/i.test(serveraddress)) {
    serveraddress = 'https://crg.apkg.io';
  } else if (!/^https?:\/\//i.test(serveraddress)) {
    serveraddress = `https://${serveraddress}`;
  }

  return { username, password, serveraddress };
}

async function dockerLogin(auth: RegistryAuth): Promise<void> {
  const normalized = normalizeRegistryAuth(auth);
  if (!normalized) throw new Error('registry auth requires username and password');
  const isHub = normalized.serveraddress === DOCKER_HUB_INDEX
    || /^https?:\/\/index\.docker\.io\b/i.test(normalized.serveraddress || '');
  // Hub CLI login: "docker.io" (not the index URL) — avoids malformed Authorization on some daemons.
  const server = isHub ? 'docker.io' : (normalized.serveraddress || DOCKER_HUB_INDEX);
  logger.info('docker login', {
    server,
    username: normalized.username,
    passwordLen: normalized.password.length,
    passwordLooksLikePat: /^dckr_pat_/i.test(normalized.password),
    usernameLooksLikeEmail: normalized.username.includes('@'),
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['login', server, '-u', normalized.username, '--password-stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker login failed (${code})`));
    });
    // No trailing newline — same as `printf '%s'`.
    child.stdin.write(Buffer.from(normalized.password, 'utf8'));
    child.stdin.end();
  });
}

function composeRootDir(): string {
  return process.env.SENTRYDOCK_COMPOSE_DIR
    || path.join(os.homedir(), '.sentrydock', 'compose');
}

function sanitizeProjectName(name: string): string {
  const n = String(name || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!n) throw new Error('compose projectName is required');
  return n;
}

function expandHome(p: string): string {
  const raw = String(p || '').trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

/** Resolve a compose file path; accepts a file or a directory with compose.yaml / docker-compose.yml. */
async function resolveComposeFile(projectPath: string): Promise<string> {
  const resolved = expandHome(projectPath);
  if (!resolved) {
    throw new Error(
      'docker.compose requires projectPath (path to docker-compose.yml). For standalone containers use recreate_container instead.',
    );
  }
  let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    st = await fs.stat(resolved);
  } catch {
    throw new Error(`compose file not found: ${resolved}`);
  }
  if (st.isFile()) return resolved;
  if (st.isDirectory()) {
    for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
      const candidate = path.join(resolved, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
    throw new Error(`no compose file in directory: ${resolved}`);
  }
  throw new Error(`invalid compose path: ${resolved}`);
}

function formatDotEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`)
    .join('\n') + (Object.keys(env).length ? '\n' : '');
}

/** Parse registry + repository path for tag listing. */
function parseRegistryRepo(image: string): { registry: string; repository: string; isDockerHub: boolean } {
  const raw = String(image || '').trim().split('@')[0]!.split(':')[0]!;
  const parts = raw.split('/');
  if (parts.length === 1) {
    return { registry: 'registry-1.docker.io', repository: `library/${parts[0]}`, isDockerHub: true };
  }
  const first = parts[0]!;
  const looksLikeRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (!looksLikeRegistry) {
    return { registry: 'registry-1.docker.io', repository: parts.join('/'), isDockerHub: true };
  }
  return {
    registry: first,
    repository: parts.slice(1).join('/'),
    isDockerHub: first === 'docker.io' || first === 'index.docker.io' || first === 'registry-1.docker.io',
  };
}

async function listImageTags(
  docker: Docker,
  imageRepo: string,
  auth?: RegistryAuth,
): Promise<string[]> {
  const { registry, repository, isDockerHub } = parseRegistryRepo(imageRepo);
  const tags = new Set<string>();

  if (isDockerHub) {
    try {
      let url: string | null =
        `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100&ordering=last_updated`;
      let pages = 0;
      while (url && pages < 5) {
        pages += 1;
        const res = await fetch(url);
        if (!res.ok) break;
        const data = await res.json() as { results?: Array<{ name?: string }>; next?: string | null };
        for (const row of data.results || []) {
          if (row.name) tags.add(row.name);
        }
        url = data.next || null;
      }
    } catch (err) {
      logger.debug('hub tags failed', { err, repository });
    }
  }

  if (tags.size === 0) {
    try {
      const proto = registry.includes('localhost') ? 'http' : 'https';
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (auth?.username) {
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      }
      const res = await fetch(`${proto}://${registry}/v2/${repository}/tags/list`, { headers });
      if (res.ok) {
        const data = await res.json() as { tags?: string[] };
        for (const t of data.tags || []) tags.add(t);
      }
    } catch (err) {
      logger.debug('registry tags/list failed', { err, registry, repository });
    }
  }

  if (tags.size === 0) {
    try {
      const images = await docker.listImages();
      const repoOnly = String(imageRepo).split('@')[0]!.split(':')[0]!;
      const aliases = [repoOnly];
      if (!repoOnly.includes('/')) aliases.push(`library/${repoOnly}`);
      for (const img of images) {
        for (const rt of img.RepoTags || []) {
          for (const a of aliases) {
            if (rt.startsWith(`${a}:`)) tags.add(rt.slice(a.length + 1));
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  return [...tags].sort();
}

function asAuth(auth?: RegistryAuth): Docker.AuthConfig | undefined {
  const normalized = normalizeRegistryAuth(auth);
  if (!normalized) return undefined;
  // Only username/password/serveraddress. Do NOT set the legacy `auth` field
  // (base64 user:pass) alongside them — Docker Engine can build a malformed
  // Authorization header when both are present.
  return {
    username: normalized.username,
    password: normalized.password,
    serveraddress: normalized.serveraddress || DOCKER_HUB_INDEX,
  };
}

function registryAuthHeader(auth?: RegistryAuth): string | undefined {
  const cfg = asAuth(auth);
  if (!cfg) return undefined;
  return Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
}

/**
 * Resolve a local image that matches desiredDigest.
 * Prefers `repo@sha256:…` (keeps the name for Config.Image); falls back to image id.
 * Throws if the previous layers were pruned after pull — rollback cannot invent them.
 */
async function resolvePinnedCreateImage(
  docker: Docker,
  imageRef: string,
  desiredDigest: string,
): Promise<string> {
  const dig = normalizeDigest(desiredDigest);
  if (!dig) return imageRef;

  const pinned = pinImageToDigest(imageRef, dig);
  for (const candidate of [pinned, dig]) {
    try {
      await docker.getImage(candidate).inspect();
      return candidate;
    } catch {
      /* try next */
    }
  }

  const images = await docker.listImages({ all: true });
  for (const img of images) {
    const idDig = normalizeDigest(img.Id);
    if (idDig === dig) return String(img.Id);
    const fromRepo = digestsFromRepoDigests(img.RepoDigests);
    if (fromRepo.includes(dig)) return String(img.Id);
  }

  throw new Error(
    `Cannot rollback: previous image ${dig} is not available locally `
    + `(tag ${imageRef} now points elsewhere and the old layers were removed). `
    + 'Keep dangling images after pull, or avoid pruning until rollback completes.',
  );
}

/**
 * Prefer a human pullable image ref (name:tag). Never invent a sha256 create name
 * when a RepoTag or Config.Image name is available.
 */
async function resolveImageRef(
  docker: Docker,
  preferred: string | undefined | null,
  fallbacks: Array<string | undefined | null> = [],
): Promise<string> {
  const candidates = [preferred, ...fallbacks].map((c) => (c ? String(c).trim() : '')).filter(Boolean);
  for (const c of candidates) {
    if (!isImageIdRef(c)) return c;
  }
  for (const c of candidates) {
    try {
      const insp = await docker.getImage(c).inspect();
      const tag = pickRepoTag(insp.RepoTags);
      if (tag) return tag;
    } catch {
      /* try next */
    }
  }
  return candidates[0] || '';
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

type RemoteDigests = {
  primary: string;
  candidates: string[];
  source: string;
  /** False when registry was reached without credentials (or auth failed and anonymous worked). */
  usedAuth: boolean;
};

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
 * Same path as Images → Test access (`image.digest`).
 */
async function getRemoteDigests(
  docker: Docker,
  image: string,
  auth?: RegistryAuth,
): Promise<RemoteDigests> {
  const tryDistribution = async (withAuth?: RegistryAuth) => {
    const data = await dialJson(docker, {
      path: `/distribution/${image}/json`,
      auth: withAuth,
    });
    const descriptor = data.Descriptor as { digest?: string } | undefined;
    const platforms = (data.Platforms as Array<{ digest?: string }> | undefined) || [];
    const candidates = uniqueDigests([
      descriptor?.digest,
      ...platforms.map((p) => p.digest),
    ]);
    if (candidates[0]) {
      return { primary: candidates[0], candidates } as { primary: string; candidates: string[] };
    }
    return null;
  };

  if (auth) {
    try {
      const hit = await tryDistribution(auth);
      if (hit) return { ...hit, source: 'distribution', usedAuth: true };
    } catch (err) {
      logger.debug('distribution inspect with auth failed', {
        err: err instanceof Error ? err.message : String(err),
        image,
      });
    }
  }

  try {
    const hit = await tryDistribution(undefined);
    if (hit) return { ...hit, source: 'distribution', usedAuth: false };
  } catch (err) {
    logger.debug('distribution inspect anonymous failed', {
      err: err instanceof Error ? err.message : String(err),
      image,
    });
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
      return { primary: candidates[0], candidates, source: 'manifest', usedAuth: false };
    }
  } catch (err) {
    logger.debug('manifest inspect failed', { err, image });
  }

  // Last resort: local RepoDigests for the tag (may be stale) — not a real registry probe.
  try {
    const insp = await docker.getImage(image).inspect();
    const local = digestsFromRepoDigests(insp.RepoDigests);
    const id = normalizeDigest(insp.Id);
    const candidates = uniqueDigests([...local, id]);
    if (candidates[0]) {
      return { primary: candidates[0], candidates, source: 'local-repodigest', usedAuth: false };
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
  const doPull = (cfg?: Docker.AuthConfig) => new Promise<void>((resolve, reject) => {
    docker.pull(image, cfg ? { authconfig: cfg } : {}, (err, stream) => {
      if (err || !stream) return reject(err || new Error('pull failed'));
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });

  // Same credential shape as Images → Test access (distribution AuthConfig).
  if (authconfig) {
    try {
      await doPull(authconfig);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('pull with AuthConfig failed; trying docker login + pull', { image, err: msg });
      try {
        await dockerLogin(auth!);
        await doPull(undefined);
        return;
      } catch (loginErr) {
        const loginMsg = loginErr instanceof Error ? loginErr.message : String(loginErr);
        throw new Error(
          `Registry pull failed for ${image}: ${msg}. docker login retry: ${loginMsg}. `
          + 'Use Docker Hub username (lowercase) + personal access token; leave server empty.',
        );
      }
    }
  }

  await doPull(undefined);
}

/**
 * Update check — same registry path as Images → Test access (`image.digest`).
 * Compares remote digests (index + platform) to the running image; no docker pull/login.
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

  const imageRef = await resolveImageRef(docker, image, [running.configImage]);
  if (!imageRef || isImageIdRef(imageRef)) {
    throw new Error(
      `Cannot check update: need a name:tag image reference (got "${image || running.configImage || beforeId}"). Re-select the image in the flow.`,
    );
  }

  const remote = await getRemoteDigests(docker, imageRef, auth);
  if (remote.source === 'local-repodigest') {
    throw new Error(
      `Cannot reach registry for ${imageRef} (fell back to local only). `
      + 'Check registry credentials on the catalog image, or run Images → Test access.',
    );
  }

  // Include image id: on containerd it often matches a platform digest from the registry.
  const localDigests = uniqueDigests([
    ...digestsFromRepoDigests(running.repoDigests),
    ...running.digests,
    beforeId,
  ]);
  const matched = remote.candidates.some((d) => localDigests.includes(d));
  const updateAvailable = Boolean(remote.primary) && !matched;

  logger.info('image.checkUpdate', {
    image: imageRef,
    mode: 'digest-compare',
    remoteDigest: remote.primary,
    remoteSource: remote.source,
    remoteCandidates: remote.candidates.length,
    localDigests,
    updateAvailable,
    usedAuth: remote.usedAuth,
  });

  return {
    updateAvailable,
    remoteDigest: remote.primary,
    remoteDigests: remote.candidates,
    remoteSource: remote.source,
    localDigests,
    imageId: beforeId,
    configImage: running.configImage,
    image: imageRef,
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
        const images = await docker.listImages().catch(() => [] as Array<{ Id?: string; RepoTags?: string[] | null }>);
        const tagById = new Map<string, string>();
        for (const img of images) {
          const tag = pickRepoTag(img.RepoTags);
          if (!tag || !img.Id) continue;
          tagById.set(img.Id, tag);
          const bare = img.Id.replace(/^sha256:/, '');
          if (bare) tagById.set(bare, tag);
          const short = bare.slice(0, 12);
          if (short) tagById.set(short, tag);
          tagById.set(`sha256:${short}`, tag);
        }
        return containers.map((c) => {
          const labels = c.Labels || {};
          const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
          const listed = c.Image || '';
          const imageId = c.ImageID || '';
          let image = listed;
          if (!image || isImageIdRef(image)) {
            image = tagById.get(imageId)
              || tagById.get(imageId.replace(/^sha256:/, ''))
              || tagById.get(imageId.replace(/^sha256:/, '').slice(0, 12))
              || tagById.get(listed)
              || tagById.get(listed.replace(/^sha256:/, ''))
              || listed;
          }
          return {
            id: c.Id,
            name,
            names: c.Names,
            image,
            imageId,
            configImage: isImageIdRef(listed) ? image : listed,
            state: c.State,
            status: c.Status,
            composeProject: labels['com.docker.compose.project'] || undefined,
            composeService: labels['com.docker.compose.service'] || undefined,
          };
        });
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
        const { id, image, desiredDigest } = p as unknown as DockerRecreatePayload;
        const container = docker.getContainer(id);
        const info = await container.inspect();
        const name = info.Name.replace(/^\//, '');
        const wasRunning = info.State.Running;
        // Prefer name:tag. Never create with a raw image id when a tag exists —
        // otherwise Config.Image becomes sha256:… and the UI can no longer pick the real name.
        const imageRef = await resolveImageRef(
          docker,
          image,
          [info.Config?.Image, info.Image],
        );
        if (!imageRef) {
          throw new Error('docker.recreate requires an image name:tag');
        }

        // When desiredDigest is set (update or rollback):
        // - If name:tag already resolves to that digest (typical update after pull),
        //   create with the tag so Config.Image stays `repo:latest` and compose can
        //   manage the service normally afterwards.
        // - If the tag points elsewhere (rollback after `:latest` moved), pin with
        //   `repo@sha256:…` so we actually get the previous layers back.
        let createImage = imageRef;
        if (desiredDigest) {
          const want = normalizeDigest(desiredDigest);
          const running = await getRunningImageDigests(docker, id);
          const already =
            (want && running.digests.includes(want))
            || (want && normalizeDigest(running.imageId) === want)
            || (want && String(running.imageId).toLowerCase().includes(want.replace(/^sha256:/, '')));
          if (already) {
            logger.info('docker.recreate skipped (already at desired digest)', { name, desiredDigest: want, imageRef });
            return {
              id: info.Id,
              name,
              image: imageRef,
              imageId: running.imageId,
              skipped: true,
              reason: 'already_at_desired_digest',
            };
          }

          let tagMatchesDesired = false;
          if (want && !isImageIdRef(imageRef) && !/@sha256:/i.test(imageRef)) {
            try {
              const tagInsp = await docker.getImage(imageRef).inspect();
              tagMatchesDesired =
                normalizeDigest(tagInsp.Id) === want
                || digestsFromRepoDigests(tagInsp.RepoDigests).includes(want);
            } catch {
              tagMatchesDesired = false;
            }
          }
          createImage = tagMatchesDesired
            ? imageRef
            : await resolvePinnedCreateImage(docker, imageRef, want || String(desiredDigest));
        }

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
          Image: createImage,
          Env: info.Config.Env,
          Cmd: info.Config.Cmd ?? undefined,
          Entrypoint: info.Config.Entrypoint ?? undefined,
          WorkingDir: info.Config.WorkingDir || undefined,
          User: info.Config.User || undefined,
          Labels: info.Config.Labels,
          ExposedPorts: info.Config.ExposedPorts,
          Volumes: info.Config.Volumes,
          HostConfig: hostConfig as Docker.ContainerCreateOptions['HostConfig'],
          NetworkingConfig: networkingConfig as Docker.ContainerCreateOptions['NetworkingConfig'],
        });
        if (wasRunning) await created.start();
        const after = await created.inspect();
        logger.info('docker.recreate done', {
          name,
          imageRef,
          createImage,
          desiredDigest: desiredDigest ? normalizeDigest(desiredDigest) : undefined,
          requestedImage: image,
          newId: created.id,
          newImage: after.Image,
          configImage: after.Config?.Image,
        });
        return {
          id: created.id,
          name,
          image: imageRef,
          createImage,
          imageId: after.Image,
          startedAt: after.State?.StartedAt,
        };
      }
      case 'docker.compose': {
        const action = String(p.action) as 'up' | 'down';
        const projectPath = await resolveComposeFile(String(p.projectPath || ''));
        const forceRecreate = Boolean(p.forceRecreate);
        const args =
          action === 'up'
            ? [
              'compose', '-f', projectPath, 'up', '-d', '--pull', 'always',
              ...(forceRecreate || Boolean(p.image) ? ['--force-recreate'] : []),
            ]
            : ['compose', '-f', projectPath, 'down'];
        const { stdout, stderr } = await execFileAsync('docker', args, {
          cwd: path.dirname(projectPath),
          timeout: 10 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr, projectPath };
      }
      case 'docker.compose.apply': {
        const projectName = sanitizeProjectName(String(p.projectName || ''));
        const yaml = String(p.yaml || '');
        if (!yaml.trim()) throw new Error('docker.compose.apply requires yaml');
        const action = (String(p.action || 'up') === 'down' ? 'down' : 'up') as 'up' | 'down';
        const forceRecreate = Boolean(p.forceRecreate);
        const envMap = (p.env && typeof p.env === 'object' && !Array.isArray(p.env))
          ? Object.fromEntries(
            Object.entries(p.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
          )
          : {};

        const registryAuths = Array.isArray(p.registryAuths) ? p.registryAuths as RegistryAuth[] : [];
        for (const auth of registryAuths) {
          if (!auth?.username || !auth?.password) continue;
          const server = auth.serveraddress || 'https://index.docker.io/v1/';
          try {
            await dockerLogin(auth);
          } catch (err) {
            throw new Error(`docker login failed for ${server}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const dir = path.join(composeRootDir(), projectName);
        await fs.mkdir(dir, { recursive: true });
        const composeFile = path.join(dir, 'docker-compose.yml');
        const envFile = path.join(dir, '.env');
        await fs.writeFile(composeFile, yaml.replace(/\r\n/g, '\n'), 'utf8');
        await fs.writeFile(envFile, formatDotEnv(envMap), 'utf8');

        // --force-recreate is required after digest-pinned rollbacks / :latest pulls:
        // compose config hash is unchanged, so without it containers stay on the old image id.
        const args =
          action === 'up'
            ? [
              'compose', '-p', projectName, '-f', composeFile, '--env-file', envFile,
              'up', '-d', '--pull', 'always',
              ...(forceRecreate ? ['--force-recreate'] : []),
            ]
            : ['compose', '-p', projectName, '-f', composeFile, '--env-file', envFile, 'down'];
        const { stdout, stderr } = await execFileAsync('docker', args, {
          cwd: dir,
          env: { ...process.env, ...envMap },
          timeout: 10 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });

        let services: unknown[] = [];
        try {
          const ps = await execFileAsync(
            'docker',
            ['compose', '-p', projectName, '-f', composeFile, 'ps', '--format', 'json'],
            { cwd: dir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
          );
          const lines = ps.stdout.trim().split('\n').filter(Boolean);
          services = lines.map((line) => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
          });
        } catch {
          /* optional */
        }

        return {
          projectName,
          projectPath: composeFile,
          action,
          forceRecreate,
          stdout,
          stderr,
          services,
        };
      }
      case 'docker.compose.status': {
        const projectName = sanitizeProjectName(String(p.projectName || ''));
        const dir = path.join(composeRootDir(), projectName);
        const composeFile = path.join(dir, 'docker-compose.yml');
        let exists = false;
        try {
          await fs.access(composeFile);
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) {
          return { projectName, exists: false, projectPath: composeFile, services: [] };
        }
        try {
          const ps = await execFileAsync(
            'docker',
            ['compose', '-p', projectName, '-f', composeFile, 'ps', '-a', '--format', 'json'],
            { cwd: dir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
          );
          const lines = ps.stdout.trim().split('\n').filter(Boolean);
          const services = lines.map((line) => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
          });
          return { projectName, exists: true, projectPath: composeFile, services };
        } catch (err) {
          return {
            projectName,
            exists: true,
            projectPath: composeFile,
            services: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
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
      case 'image.listTags': {
        const imageRepo = String(p.imageRepo || p.image || '');
        if (!imageRepo) throw new Error('image.listTags requires imageRepo');
        const tags = await listImageTags(docker, imageRepo, p.auth as RegistryAuth | undefined);
        return { imageRepo, tags };
      }
      case 'image.listLocal': {
        const images = await docker.listImages();
        const out: Array<{ repository: string; tag: string; repoTag: string }> = [];
        const seen = new Set<string>();
        for (const img of images) {
          for (const rt of img.RepoTags || []) {
            if (!rt || rt.includes('<none>')) continue;
            if (seen.has(rt)) continue;
            seen.add(rt);
            const lastColon = rt.lastIndexOf(':');
            const lastSlash = rt.lastIndexOf('/');
            if (lastColon > lastSlash && lastColon > 0) {
              out.push({
                repository: rt.slice(0, lastColon),
                tag: rt.slice(lastColon + 1),
                repoTag: rt,
              });
            } else {
              out.push({ repository: rt, tag: 'latest', repoTag: `${rt}:latest` });
            }
          }
        }
        out.sort((a, b) => a.repoTag.localeCompare(b.repoTag));
        return { images: out };
      }
      case 'inventory.disk': {
        const df = await docker.df();
        const images = (df.Images || []) as Array<{ Dangling?: boolean; SharedSize?: number; Size?: number }>;
        const dangling = images.filter((i) => i.Dangling).length;
        const layersSize = images.reduce((s, i) => s + (i.Size || i.SharedSize || 0), 0);
        let diskTotalBytes: number | null = null;
        try {
          const info = await docker.info();
          // Docker Desktop / engine may expose dockerRootDir; try df -B1 on host path via shell
          const root = String((info as { DockerRootDir?: string }).DockerRootDir || '/var/lib/docker');
          const { stdout } = await execFileAsync('df', ['-B1', '--output=size', root], {
            timeout: 5000,
            maxBuffer: 64 * 1024,
          });
          const line = stdout.trim().split('\n').pop();
          const n = Number(line);
          if (Number.isFinite(n) && n > 0) diskTotalBytes = n;
        } catch {
          /* optional */
        }
        return {
          danglingImages: dangling,
          diskUsedBytes: layersSize,
          diskTotalBytes,
        };
      }
      default:
        throw new Error(`Unknown command: ${type}`);
    }
}
