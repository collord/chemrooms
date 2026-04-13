/**
 * Runtime loader for geoparquet data sources.
 *
 * Takes a File (dropped from the OS) or a URL, registers the bytes
 * as a DuckDB-WASM table via the connector's loadFile API, ensures
 * the spatial extension is loaded, and produces a freshly-frozen
 * LayerConfig pointing at the new table.
 *
 * The big idea: the user drops a file, this function does the work
 * to get it queryable and visible, and the rest of the layer
 * pipeline (buildLayerSql → useChemroomsEntities) handles rendering
 * unchanged.
 *
 * ## What it does NOT do (yet)
 *
 * - **Verify expectedHash.** When the layer config has a pin set,
 *   we should SHA-256 the bytes before registration and reject on
 *   mismatch. Deferred because (a) the freshly-dropped path doesn't
 *   have a pin yet, and (b) hashing is async and adds latency we
 *   want to budget for deliberately.
 *
 * - **Read the parquet `geo` metadata.** A real geoparquet file
 *   carries the geometry column name, geometry type, CRS, and bbox
 *   in a JSON metadata key. Reading that and using it to default
 *   the layer config fields would be a big UX win — the user
 *   wouldn't need to specify `geometryColumn` at all for any
 *   spec-compliant file. Deferred because parsing parquet metadata
 *   in-browser is its own engineering chunk; for now we trust the
 *   geoparquet convention (column = `geometry`, type = point) and
 *   the user can override via the layer config.
 *
 * - **Reproject non-WGS84 sources.** If `sourceCrs` is set and
 *   isn't EPSG:4326, we should run `ST_Transform` at registration
 *   time to materialize a 4326 view. Deferred because it requires
 *   PROJ data in DuckDB-WASM, which I haven't verified is bundled
 *   in the chemrooms environment.
 *
 * - **Handle non-point geometries.** Until the vector renderer
 *   exists, registering a polygon geoparquet succeeds but the
 *   layer renders nothing (buildLayerSql returns null for non-point
 *   types). The function logs a warning so the user knows.
 *
 * Each of these is a labeled TODO that the next session can pick
 * up incrementally without rewriting this loader.
 */

import type {DuckDbConnector} from '@sqlrooms/duckdb';
import {
  freezeCurrentState,
  GeoParquetDataSource,
  parseLayerConfig,
  type LayerConfig,
} from './layerSchema';
import {computeLayerHash} from './layerHash';

/**
 * Sanitize a user-provided string into a safe DuckDB table name.
 * Only word characters and digits survive; anything else is
 * replaced with `_`. We prefix with `t_` so a leading digit (which
 * isn't a valid identifier start in some SQL dialects) is always
 * valid, and append a short hash so two files with the same name
 * (`wells.parquet` from different folders) don't collide.
 */
function makeTableName(rawName: string, suffix: string): string {
  const cleaned = rawName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+/, '');
  return `t_${cleaned || 'layer'}_${suffix}`;
}

/** Short random suffix for table-name disambiguation. Not a hash. */
function shortRandom(): string {
  return Math.random().toString(36).slice(2, 8);
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
  const tableName = makeTableName(displayName, shortRandom());

  // loadFile handles both File and URL inputs and dispatches based
  // on the method option. For geoparquet we use plain read_parquet
  // because it's the cheapest; the spatial extension's WKB decoding
  // happens at query time via ST_GeomFromWKB (see buildLayerSql).
  await connector.loadFile(source, tableName, {method: 'read_parquet'});

  // Build the layer config. Run through parseLayerConfig so all the
  // schema defaults (geometryColumn='geometry', geometryType='point',
  // is3d=false, geometryEncoding='wkb', etc.) get filled in.
  const draft = parseLayerConfig({
    version: 1,
    id: '',
    name: displayName,
    dataSource: {
      type: 'geoparquet',
      url: source instanceof File ? `file://${source.name}` : source,
      tableName,
      geometryColumn: options.geometryColumn,
      geometryType: options.geometryType,
      is3d: options.is3d,
      geometryEncoding: options.geometryEncoding,
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

// freezeCurrentState is imported above only so the file shows up in
// the schema's dependency graph; the loader builds layers via
// parseLayerConfig directly because it needs full control over the
// dataSource shape (freezeCurrentState only knows about chemduck).
void freezeCurrentState;

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
