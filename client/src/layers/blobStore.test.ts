/**
 * Tests for the content-addressed blob store.
 *
 * Uses the InMemoryBlobBackend so we don't have to stand up IDB in
 * the test environment — the IdbBlobBackend is exercised only by
 * smoke-testing in the browser. The module-level API functions
 * (putBlob / getBlob / etc) are the ones that get imported from
 * production code, so we test those against the swapped-in backend.
 */

import {describe, it, expect, beforeEach, afterAll} from 'vitest';
import {
  _resetBlobBackendForTesting,
  _setBlobBackendForTesting,
  deleteBlob,
  getBlob,
  hasBlob,
  IDB_URL_PREFIX,
  InMemoryBlobBackend,
  isIdbUrl,
  listBlobHashes,
  makeIdbUrl,
  parseIdbUrl,
  putBlob,
  sha256Hex,
} from './blobStore';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

beforeEach(() => {
  _setBlobBackendForTesting(new InMemoryBlobBackend());
});

afterAll(() => {
  _resetBlobBackendForTesting();
});

describe('sha256Hex', () => {
  it('produces a 64-character lowercase hex string', async () => {
    const hash = await sha256Hex(bytes(1, 2, 3));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', async () => {
    const a = await sha256Hex(bytes(1, 2, 3));
    const b = await sha256Hex(bytes(1, 2, 3));
    expect(a).toBe(b);
  });

  it('changes when the bytes change', async () => {
    const a = await sha256Hex(bytes(1, 2, 3));
    const b = await sha256Hex(bytes(1, 2, 4));
    expect(a).not.toBe(b);
  });

  it('matches the known SHA-256 of an empty buffer', async () => {
    const hash = await sha256Hex(new Uint8Array(0));
    expect(hash).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('putBlob / getBlob / hasBlob', () => {
  it('stores bytes and returns the content hash', async () => {
    const input = bytes(10, 20, 30);
    const hash = await putBlob(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const retrieved = await getBlob(hash);
    expect(retrieved).not.toBeNull();
    expect(Array.from(retrieved!)).toEqual([10, 20, 30]);
  });

  it('is idempotent — storing the same bytes twice yields the same hash', async () => {
    const h1 = await putBlob(bytes(1, 2, 3));
    const h2 = await putBlob(bytes(1, 2, 3));
    expect(h1).toBe(h2);
    expect((await listBlobHashes()).length).toBe(1);
  });

  it('dedupes bytes across distinct put calls with different array instances', async () => {
    // Same content, different Uint8Array objects
    const h1 = await putBlob(new Uint8Array([1, 2, 3]));
    const h2 = await putBlob(new Uint8Array([1, 2, 3]));
    expect(h1).toBe(h2);
  });

  it('distinguishes different content', async () => {
    const h1 = await putBlob(bytes(1, 2, 3));
    const h2 = await putBlob(bytes(1, 2, 4));
    expect(h1).not.toBe(h2);
    expect((await listBlobHashes()).length).toBe(2);
  });

  it('hasBlob reports presence correctly', async () => {
    const hash = await putBlob(bytes(1, 2, 3));
    expect(await hasBlob(hash)).toBe(true);
    expect(await hasBlob('0'.repeat(64))).toBe(false);
  });

  it('getBlob returns null for missing hashes', async () => {
    expect(await getBlob('0'.repeat(64))).toBeNull();
  });
});

describe('deleteBlob', () => {
  it('removes a stored blob', async () => {
    const hash = await putBlob(bytes(1, 2, 3));
    expect(await hasBlob(hash)).toBe(true);
    await deleteBlob(hash);
    expect(await hasBlob(hash)).toBe(false);
    expect(await getBlob(hash)).toBeNull();
  });

  it('is a no-op for unknown hashes', async () => {
    await deleteBlob('0'.repeat(64));
    // No throw, no crash
  });
});

describe('listBlobHashes', () => {
  it('returns an empty list when nothing has been stored', async () => {
    expect(await listBlobHashes()).toEqual([]);
  });

  it('returns the hashes of all stored blobs', async () => {
    const h1 = await putBlob(bytes(1));
    const h2 = await putBlob(bytes(2));
    const h3 = await putBlob(bytes(3));
    const hashes = await listBlobHashes();
    expect(hashes.sort()).toEqual([h1, h2, h3].sort());
  });
});

describe('idb:// URL helpers', () => {
  const sampleHash =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('makeIdbUrl prefixes the hash', () => {
    expect(makeIdbUrl(sampleHash)).toBe(`${IDB_URL_PREFIX}${sampleHash}`);
  });

  it('parseIdbUrl extracts the hash', () => {
    expect(parseIdbUrl(makeIdbUrl(sampleHash))).toBe(sampleHash);
  });

  it('parseIdbUrl returns null for non-idb URLs', () => {
    expect(parseIdbUrl('https://example.com/wells.parquet')).toBeNull();
    expect(parseIdbUrl('session:foo.parquet')).toBeNull();
    expect(parseIdbUrl('file://whatever')).toBeNull();
  });

  it('isIdbUrl detects the prefix', () => {
    expect(isIdbUrl(makeIdbUrl(sampleHash))).toBe(true);
    expect(isIdbUrl('https://example.com/wells.parquet')).toBe(false);
    expect(isIdbUrl('session:foo.parquet')).toBe(false);
  });
});

describe('round-trip: file bytes → putBlob → getBlob → round-trip match', () => {
  it('preserves byte content exactly', async () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;

    const hash = await putBlob(original);
    const retrieved = await getBlob(hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(original.length);
    for (let i = 0; i < 256; i++) {
      expect(retrieved![i]).toBe(i);
    }
  });
});
