/**
 * Runtime loader for geoparquet data sources.
 *
 * Takes a File (dropped from the OS) or a URL, registers the bytes
 * as a DuckDB-WASM table via the connector's loadFile API, ensures
 * the spatial extension is loaded, and produces a freshly-frozen
 * LayerConfig pointing at the new table.
 *
 * ## Two input paths
 *
 * **File input** (drag-and-drop): bytes are read, SHA-256-hashed,
 * stored in the local content-addressed blob store
 * ([blobStore.ts](./blobStore.ts)) keyed by that hash, registered
 * into DuckDB under a table name deterministically derived from
 * the hash, and returned as a persistable layer config whose URL is
 * `idb://<hash>`. Dropping the same file twice produces the same
 * hash → same table name → same layer id → deduped across sessions.
 * Reloading re-materializes the layer via rehydrateGeoparquetLayers
 * (reads bytes back from IDB, re-registers).
 *
 * **URL input** (layer config with a URL): bytes come from the URL.
 * The table name is derived from the URL string hash so dedupe
 * still works, but no IDB write — the URL is the persistent pointer.
 *
 * ## What it does NOT do (yet)
 *
 * - **Verify expectedHash for URL inputs.** When the layer config
 *   has a pin set on a URL source, we should SHA-256 the fetched
 *   bytes and reject on mismatch. Deferred.
 *
 * - **Read the parquet `geo` metadata.** A real geoparquet file
 *   carries the geometry column name, geometry type, CRS, and bbox
 *   in a JSON metadata key. Reading that and using it to default
 *   the layer config fields would be a big UX win for files with
 *   non-convention column names. Deferred because parsing parquet
 *   metadata in-browser is its own engineering chunk.
 *
 * - **Reproject non-WGS84 sources.** If `sourceCrs` is set and
 *   isn't EPSG:4326, we should run `ST_Transform` at registration
 *   time. Deferred because it requires PROJ data in DuckDB-WASM.
 *
 * - **Handle non-point geometries.** Registration succeeds but the
 *   layer renders nothing (buildLayerSql returns null for non-point
 *   types) until the vector renderer exists.
 */

import type {DuckDbConnector} from '@sqlrooms/duckdb';
import {
  GeoParquetDataSource,
  parseLayerConfig,
  type LayerConfig,
} from './layerSchema';
import {computeLayerHash} from './layerHash';
import {
  getBlob,
  makeIdbUrl,
  parseIdbUrl,
  putBlob,
  sha256Hex,
} from './blobStore';

/**
 * Deterministic DuckDB table name derived from a content hash.
 *
 * Using the hash as the table name (rather than a random suffix)
 * means the same bytes always produce the same table name — so on
 * reload, rehydrateGeoparquetLayers can re-register the bytes under
 * the same name and the saved layer config's `tableName` stays
 * valid. Also enables content-addressed dedupe: two drops of the
 * same file collapse to one table and one layer.
 */
function tableNameFromHash(hash: string): string {
  // First 16 hex chars is plenty of collision resistance for the
  // table-name namespace (you'd need 2^32 distinct tables before
  // collisions become likely).
  return `t_geoparquet_${hash.slice(0, 16)}`;
}

/**
 * One-time spatial extension load. The promise is cached so
 * concurrent calls share the same INSTALL/LOAD invocation and
 * subsequent calls are no-ops.
 */
let spatialReadyPromise: Promise<void> | null = null;
async function ensureSpatialLoaded(connector: DuckDbConnector): Promise<void> {
  if (!spatialReadyPromise) {
    spatialReadyPromise = (async () => {
      try {
        await connector.execute('INSTALL spatial');
        await connector.execute('LOAD spatial');
      } catch (e) {
        // Reset so a future call can retry — otherwise a transient
        // failure would permanently block the loader.
        spatialReadyPromise = null;
        throw e;
      }
    })();
  }
  return spatialReadyPromise;
}

/** For tests / cleanup: reset the cached spatial-ready state. */
export function _resetSpatialReadyForTesting(): void {
  spatialReadyPromise = null;
}

export interface RegisterGeoparquetOptions {
  /**
   * Display name for the layer. Defaults to the file's name (or the
   * URL's basename) without the extension.
   */
  displayName?: string;
  /**
   * Pre-loaded geometry descriptor overrides. The runtime defaults
   * to the geoparquet convention (`geometry` column, point type,
   * 2D, WKB-encoded). Pass these to override before the user has
   * had a chance to.
   */
  geometryColumn?: string;
  geometryType?: GeoParquetDataSource['geometryType'];
  is3d?: boolean;
  geometryEncoding?: GeoParquetDataSource['geometryEncoding'];
}

export interface RegisterGeoparquetResult {
  /** The registered DuckDB table name. */
  tableName: string;
  /** A complete, frozen LayerConfig pointing at the table. */
  layer: LayerConfig;
}

/**
 * Register a dropped File or a URL as a geoparquet table and
 * produce a LayerConfig for it. Caller is responsible for adding
 * the result to the personal-layers slice (so this function stays
 * decoupled from React state).
 *
 * For File inputs, bytes are also persisted to the local content-
 * addressed blob store (IDB), and the returned layer config's URL
 * is `idb://<sha256>`. That makes the layer restorable on reload —
 * see rehydrateGeoparquetLayers.
 */
export async function registerGeoparquetLayer(
  connector: DuckDbConnector,
  source: File | string,
  options: RegisterGeoparquetOptions = {},
): Promise<RegisterGeoparquetResult> {
  await ensureSpatialLoaded(connector);

  const rawName =
    options.displayName ??
    (source instanceof File ? source.name : basenameFromUrl(source));
  const displayName = stripExtension(rawName);

  let tableName: string;
  let sourceUrl: string;

  if (source instanceof File) {
    // Hash the bytes, store in IDB, derive table name from the hash.
    // Dropping the same file twice (same bytes) → same hash → same
    // table name → dedupes at the layer-id level too.
    const buffer = new Uint8Array(await source.arrayBuffer());
    const hash = await putBlob(buffer);
    tableName = tableNameFromHash(hash);
    sourceUrl = makeIdbUrl(hash);
    // Register into DuckDB from the original File (avoids re-wrapping
    // the bytes). Safe to call loadFile even if the table already
    // exists? We pass replace to be explicit.
    await connector.loadFile(source, tableName, {
      method: 'read_parquet',
      replace: true,
    });
  } else {
    // URL input: hash the URL string so repeated registrations of
    // the same URL share a table name (dedupe), but don't write to
    // IDB — the URL is already the persistent pointer.
    const urlHash = await sha256Hex(new TextEncoder().encode(source));
    tableName = tableNameFromHash(urlHash);
    sourceUrl = source;
    await connector.loadFile(source, tableName, {
      method: 'read_parquet',
      replace: true,
    });
  }

  // Build the layer config. Run through parseLayerConfig so all the
  // schema defaults get filled in. Default encoding is 'native'
  // because loadFile(read_parquet) + a loaded spatial extension
  // auto-decodes a geoparquet's WKB geometry column into a native
  // GEOMETRY type.
  const draft = parseLayerConfig({
    version: 1,
    id: '',
    name: displayName,
    dataSource: {
      type: 'geoparquet',
      url: sourceUrl,
      tableName,
      geometryColumn: options.geometryColumn,
      geometryType: options.geometryType,
      is3d: options.is3d,
      geometryEncoding: options.geometryEncoding ?? 'native',
    },
    visible: true,
    createdAt: new Date().toISOString(),
    origin: 'personal',
  });

  if (!draft) {
    throw new Error(
      `[registerGeoparquetLayer] failed to parse layer config for ${displayName}`,
    );
  }

  const id = await computeLayerHash(draft);
  const layer = {...draft, id};

  // Soft-warn for non-point geometry: registration succeeded but
  // buildLayerSql will return null and the entity pipeline will
  // skip the layer until the vector renderer exists.
  if (layer.dataSource.type === 'geoparquet' && layer.dataSource.geometryType !== 'point') {
    console.warn(
      `[registerGeoparquetLayer] registered ${tableName} as ${layer.dataSource.geometryType} — ` +
        `non-point geometries are not yet rendered by the entity pipeline; ` +
        `the layer will appear in the panel but won't draw anything until the vector renderer is built.`,
    );
  }

  return {tableName, layer};
}

/**
 * Rehydrate geoparquet layers that live in the local blob store.
 *
 * Runs on app boot after the connector is ready. Walks the personal
 * layer list, finds entries whose URL is `idb://<hash>`, loads the
 * bytes from the blob store, and re-registers them into DuckDB
 * under the same (deterministic) table name. Layers whose bytes
 * have been evicted from IDB — quota pressure, user cleared site
 * data, etc. — are dropped from the returned list so the slice
 * isn't left with dangling references.
 *
 * Returns the filtered layer list. Callers are responsible for
 * feeding it back into the slice and writing the cleanup to
 * localStorage if any layers were dropped.
 */
export async function rehydrateGeoparquetLayers(
  connector: DuckDbConnector,
  layers: LayerConfig[],
): Promise<{layers: LayerConfig[]; dropped: number}> {
  let spatialLoaded = false;
  const kept: LayerConfig[] = [];
  let dropped = 0;

  for (const layer of layers) {
    if (layer.dataSource.type !== 'geoparquet') {
      kept.push(layer);
      continue;
    }
    const url = layer.dataSource.url;
    const hash = parseIdbUrl(url);
    if (hash === null) {
      // Not an idb:// URL — a URL-backed layer, leave it alone.
      // The caller (or the dispatcher hitting loadFile lazily)
      // handles URL-backed registration.
      kept.push(layer);
      continue;
    }

    const bytes = await getBlob(hash);
    if (!bytes) {
      console.warn(
        `[rehydrate] blob ${hash.slice(0, 12)}... missing for layer "${layer.name}" — dropping`,
      );
      dropped += 1;
      continue;
    }

    if (!spatialLoaded) {
      await ensureSpatialLoaded(connector);
      spatialLoaded = true;
    }

    const file = new File([bytes as BlobPart], `${layer.name}.parquet`, {
      type: 'application/octet-stream',
    });
    try {
      await connector.loadFile(file, layer.dataSource.tableName, {
        method: 'read_parquet',
        replace: true,
      });
      kept.push(layer);
    } catch (e) {
      console.error(
        `[rehydrate] failed to re-register layer "${layer.name}":`,
        e,
      );
      dropped += 1;
    }
  }

  return {layers: kept, dropped};
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url, 'http://placeholder.invalid');
    const last = u.pathname.split('/').pop() ?? '';
    // Decode percent-encoded characters so 'regulator%20wells.parquet'
    // becomes 'regulator wells.parquet' before sanitization.
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
