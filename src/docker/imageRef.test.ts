import { describe, expect, it } from 'vitest';
import {
  digestsFromRepoDigests,
  isImageIdRef,
  normalizeDigest,
  pinImageToDigest,
  pickRepoTag,
} from './imageRef.js';

describe('normalizeDigest', () => {
  it('extracts sha256 digest from raw or repo@digest', () => {
    expect(normalizeDigest('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'))
      .toBe('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    expect(normalizeDigest('tiag0ss/container-test@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'))
      .toBe('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  });

  it('returns null for empty or invalid', () => {
    expect(normalizeDigest(null)).toBeNull();
    expect(normalizeDigest('latest')).toBeNull();
  });
});

describe('isImageIdRef', () => {
  it('detects image ids', () => {
    expect(isImageIdRef('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toBe(true);
    expect(isImageIdRef('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toBe(true);
  });

  it('rejects name:tag and digest-pinned refs', () => {
    expect(isImageIdRef('tiag0ss/container-test:latest')).toBe(false);
    expect(isImageIdRef('tiag0ss/container-test@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toBe(false);
  });
});

describe('pinImageToDigest', () => {
  const dig = 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

  it('pins mutable tag to repo@digest for rollback after :latest pull', () => {
    expect(pinImageToDigest('tiag0ss/container-test:latest', dig))
      .toBe(`tiag0ss/container-test@${dig}`);
  });

  it('replaces existing @digest pin', () => {
    const old = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    expect(pinImageToDigest(`tiag0ss/container-test@${old}`, dig))
      .toBe(`tiag0ss/container-test@${dig}`);
  });

  it('returns imageRef unchanged when digest invalid', () => {
    expect(pinImageToDigest('tiag0ss/container-test:latest', 'not-a-digest'))
      .toBe('tiag0ss/container-test:latest');
  });
});

describe('pickRepoTag', () => {
  it('skips none tags', () => {
    expect(pickRepoTag(['<none>:<none>', 'repo:1.0'])).toBe('repo:1.0');
    expect(pickRepoTag(['<none>:<none>'])).toBeNull();
  });
});

describe('digestsFromRepoDigests', () => {
  it('parses RepoDigests list', () => {
    const dig = 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    expect(digestsFromRepoDigests([`repo@${dig}`, 'junk'])).toEqual([dig]);
  });
});
