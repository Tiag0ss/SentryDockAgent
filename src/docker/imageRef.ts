/**
 * Pure helpers for Docker image refs / digests (unit-testable).
 */

export function normalizeDigest(value: string | undefined | null): string | null {
  if (!value) return null;
  const m = String(value).match(/sha256:[a-f0-9]{64}/i);
  return m ? m[0].toLowerCase() : null;
}

/** True when the ref is an image id / digest, not a pullable name:tag. */
export function isImageIdRef(value: string | undefined | null): boolean {
  if (!value) return false;
  const v = String(value).trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(v)) return true;
  if (/^[a-f0-9]{64}$/i.test(v)) return true;
  if (/^sha256:[a-f0-9]{12,}$/i.test(v) && !v.includes('/')) return true;
  return false;
}

export function pickRepoTag(repoTags: string[] | null | undefined): string | null {
  if (!repoTags?.length) return null;
  const tag = repoTags.find((t) => t && t !== '<none>:<none>');
  return tag || null;
}

/**
 * Build a digest-pinned ref (`repo@sha256:…`) so `:latest` (or any mutable tag)
 * cannot resolve to a different image after a pull.
 */
export function pinImageToDigest(imageRef: string, digest: string): string {
  const dig = normalizeDigest(digest);
  if (!dig) return imageRef;
  if (isImageIdRef(imageRef)) return dig;

  const withoutAt = imageRef.replace(/@sha256:[a-f0-9]+$/i, '');
  const slash = withoutAt.lastIndexOf('/');
  const colon = withoutAt.lastIndexOf(':');
  const repo = colon > slash ? withoutAt.slice(0, colon) : withoutAt;
  return `${repo}@${dig}`;
}

/** Extract sha256 digests from RepoDigests like `repo@sha256:...`. */
export function digestsFromRepoDigests(repoDigests: string[] | undefined): string[] {
  if (!repoDigests?.length) return [];
  return repoDigests
    .map((d) => normalizeDigest(d))
    .filter((d): d is string => Boolean(d));
}
