/**
 * Local content-addressed blob store — the "bucket" for bytes that
 * need to survive browser reloads but live only on the user's
 * machine (dragged-in files, for now).
 *
 * Two roles:
 *
 * 1. **Storage of raw bytes** for dragged-in geoparquet (and later
 *    shapefile/gpkg/csv) files, so the user can drop a file, reload
 *    the page, and find the layer still there.
 *
 * 2. **Content-addressed dedupe.** The key IS the SHA-256 of the
 *    bytes, so dropping the same file twice (even with different
 *    filenames, different folders, different browsers) produces one
 *    entry. That gives us the same "files stop colliding" payoff
 *    the layer-config content hashing gives us, but at the byte
 *    level rather than the recipe level.
 *
 * ## Architecture
 *
 * The store is defined by a small `BlobBackend` interface with
 * put / get / has / list / delete. Two implementations:
 *
 * - **IdbBlobBackend** (default, production): IndexedDB. Survives
 *   reloads, 50MB+ quota on most browsers, no user prompt for
 *   reasonable sizes. Uses one object store keyed by hash.
 *
 * - **InMemoryBlobBackend** (tests): a plain Map. Instant,
 *   deterministic, no globals to clean up between test cases.
 *
 * Dependency injection at module level via _setBlobBackendForTesting
 * keeps the module API synchronous-looking for callers while letting
 * tests swap the backend without monkey-patching globals.
 *
 * ## The URL scheme
 *
 * A layer stored here gets a URL of the form `idb://<sha256-hex>`.
 * The prefix is our signal that "resolve this bytes reference via
 * the local blob store" and distinguishes stored layers from URL-
 * backed and session-ephemeral ones in a glance. registerGeoparquet-
 * Layer sets this URL, and rehydrateGeoparquetLayers reads it on
 * boot to re-register the bytes into DuckDB.
 *
 * ## What it does NOT do
 *
 * - **Garbage collection.** Orphan blobs (no layer config references
 *   them) accumulate forever. Once the blob-store conversation from
 *   the architecture proposal lands a real GC path, that will apply
 *   here too. For now, `listOrphans` gives you a list and you can
 *   manually prune.
 * - **Quota management.** If IDB is full, puts fail with a real
 *   DOMException — no automatic eviction.
 * - **Mirroring to a remote bucket.** That's the S3/SharePoint
 *   chunk from the architecture proposal. This store is the
 *   always-local tier.
 */

export interface BlobBackend {
  put(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  list(): Promise<string[]>;
  delete(hash: string): Promise<void>;
}

const DB_NAME = 'chemrooms';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbBlobBackend implements BlobBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb().catch((e) => {
        this.dbPromise = null;
        throw e;
      });
    }
    return this.dbPromise;
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(bytes, hash);
    await promisify(
      tx as unknown as IDBRequest<undefined>, // transaction completes via onсomplete
    ).catch(() => {});
    // Wait for the transaction to finish rather than just the put
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const result = await promisify(tx.objectStore(STORE_NAME).get(hash));
    return (result as Uint8Array | undefined) ?? null;
  }

  async has(hash: string): Promise<boolean> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const count = await promisify(tx.objectStore(STORE_NAME).count(hash));
    return count > 0;
  }

  async list(): Promise<string[]> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const keys = await promisify(tx.objectStore(STORE_NAME).getAllKeys());
    return (keys as IDBValidKey[]).map((k) => String(k));
  }

  async delete(hash: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(hash);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }
}

export class InMemoryBlobBackend implements BlobBackend {
  private store = new Map<string, Uint8Array>();

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    this.store.set(hash, bytes);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.store.get(hash) ?? null;
  }

  async has(hash: string): Promise<boolean> {
    return this.store.has(hash);
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  async delete(hash: string): Promise<void> {
    this.store.delete(hash);
  }
}

// Module-level default backend. Production code never touches this
// directly — use the exported functions below.
let currentBackend: BlobBackend = new IdbBlobBackend();

/** Test helper: swap in a different backend for the duration of a test. */
export function _setBlobBackendForTesting(backend: BlobBackend): void {
  currentBackend = backend;
}

/** Reset to the default IDB backend. Call at end of test suites. */
export function _resetBlobBackendForTesting(): void {
  currentBackend = new IdbBlobBackend();
}

/**
 * Compute the hex SHA-256 of a byte buffer. Exposed so callers can
 * hash once and use the result for both store lookup and layer
 * construction. Full 64-hex string — not truncated, because blob
 * hashes need stronger collision resistance than layer-config
 * hashes (millions of distinct files across all users, vs hundreds
 * of layer configs per project).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Put a blob in the store and return its content hash. Idempotent
 * — if the same bytes are already present, this is effectively a
 * no-op (the hash matches, put just rewrites the same value).
 */
export async function putBlob(bytes: Uint8Array): Promise<string> {
  const hash = await sha256Hex(bytes);
  const already = await currentBackend.has(hash);
  if (!already) {
    await currentBackend.put(hash, bytes);
  }
  return hash;
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  return currentBackend.get(hash);
}

export async function hasBlob(hash: string): Promise<boolean> {
  return currentBackend.has(hash);
}

export async function listBlobHashes(): Promise<string[]> {
  return currentBackend.list();
}

export async function deleteBlob(hash: string): Promise<void> {
  return currentBackend.delete(hash);
}

// ---------------------------------------------------------------------------
// URL scheme helpers
// ---------------------------------------------------------------------------

/** The prefix that marks a URL as "resolve this via the local blob store." */
export const IDB_URL_PREFIX = 'idb://';

/** Build an idb:// URL from a content hash. */
export function makeIdbUrl(hash: string): string {
  return `${IDB_URL_PREFIX}${hash}`;
}

/** Extract the content hash from an idb:// URL, or null if the URL isn't one. */
export function parseIdbUrl(url: string): string | null {
  if (!url.startsWith(IDB_URL_PREFIX)) return null;
  return url.slice(IDB_URL_PREFIX.length);
}

/** Whether a URL points at the local blob store. */
export function isIdbUrl(url: string): boolean {
  return url.startsWith(IDB_URL_PREFIX);
}
