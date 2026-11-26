/**
 * An EQuIS Analytical Results II (ARII) parquet set as the `results` table.
 *
 * The data folder (DATA_BASE_URL) holds the sidecars ChemDuck's `publish`
 * wrote, by the QGIS plugin's pipeline (`chemduck/`) or server/publish_arii.py
 * (`chemrooms/`): samples, locations and catalog
 * tables (loaded by SQLRooms url data sources, see store.ts), the ChemDuck
 * SQL bundle, `sidecars.json`, and `sql/results_view.sql`. The partitions
 * themselves stay where the export pipeline published them, named by
 * `manifest.json` at ARII_MANIFEST_URL.
 *
 * `results` is a VIEW over those partitions, not a table. SQLRooms data
 * sources cannot provide one: a `url` source downloads the whole file and
 * copies it into a table (room-shell downloadRoomFiles -> loadFile), which
 * for the test facility is 121 MB before the first query. Instead each partition is
 * registered with DuckDB-WASM's HTTP protocol, which reads byte ranges, and
 * a query for one analyte fetches only the row groups that hold it.
 *
 * Everything here refuses rather than guesses:
 *  - sidecars built from a different manifest (sha256 of the manifest bytes);
 *  - a manifest whose partitions are not the ones the sidecars list;
 *  - files whose footers disagree with the manifest's row count.
 * Any of those would otherwise draw a plausible map of the wrong data.
 */

import {DuckDBDataProtocol} from '@duckdb/duckdb-wasm';
import type {DuckDbConnector} from '@sqlrooms/duckdb';
import {joinUrl} from '../config';

export class AriiSourceError extends Error {}

export interface AriiPartition {
  path: string;
  rows: number | null;
  /** When the export pipeline last rebuilt this partition, if recorded. */
  as_of: string | null;
}

/** The parts of sidecars.json this client reads. */
export interface Sidecars {
  format: string;
  version: number;
  generated: string;
  chemduck: {commit: string | null; dirty: boolean | null};
  source_manifest: {
    sha256: string;
    facility: string | null;
    rows: number;
    partitions: AriiPartition[];
  };
  coordinates: {x: string; y: string; crs: string; unplaced_locations: number};
  tables: Record<string, {file: string; rows: number}>;
  results_view: {file: string; files_token: string; rows: number};
}

/** What the UI shows about where the data came from and how old it is. */
export interface AriiSourceInfo {
  kind: 'arii';
  facility: string | null;
  manifestUrl: string;
  rows: number;
  partitions: AriiPartition[];
  sidecarsGenerated: string;
  unplacedLocations: number;
  chemduckCommit: string | null;
}

export const SIDECAR_FORMAT = 'chemduck-arii-sidecars';
export const SIDECAR_VERSION = 1;

/**
 * URL of one partition: the manifest's folder plus the partition's path,
 * with the manifest URL's query string (a SAS token, say) appended LAST.
 * Putting the path after the `?` is the classic way to send a signed URL
 * to the wrong blob.
 */
export function partitionUrl(manifestUrl: string, path: string): string {
  const q = manifestUrl.indexOf('?');
  const base = q >= 0 ? manifestUrl.slice(0, q) : manifestUrl;
  const query = q >= 0 ? manifestUrl.slice(q) : '';
  const folder = base.slice(0, base.lastIndexOf('/') + 1);
  return folder + path.split('/').map(encodeURIComponent).join('/') + query;
}

/** A DuckDB list literal of names, as chemduck's files_literal writes it. */
export function filesLiteral(names: string[]): string {
  return `[${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ')}]`;
}

/** The published view SQL with the partition names in place of the token. */
export function resultsViewSql(
  template: string,
  token: string,
  names: string[],
): string {
  if (!template.includes(token)) {
    throw new AriiSourceError(
      `results_view.sql has no ${token} placeholder; republish the sidecars`,
    );
  }
  return template.split(token).join(filesLiteral(names));
}

export async function sha256Prefixed(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

/**
 * Check that sidecars and a manifest belong together. Pure, so it can be
 * tested without a network or a database.
 */
export function checkSidecarsMatch(
  sidecars: Sidecars,
  manifest: {rows?: number; partitions?: {path: string; rows?: number}[]},
  manifestSha: string,
): void {
  if (sidecars.format !== SIDECAR_FORMAT || sidecars.version !== SIDECAR_VERSION) {
    throw new AriiSourceError(
      `sidecars.json is not ${SIDECAR_FORMAT} v${SIDECAR_VERSION} ` +
        `(got ${sidecars.format} v${sidecars.version})`,
    );
  }
  if (manifestSha !== sidecars.source_manifest.sha256) {
    // The usual cause is a night whose sidecar step failed: the pipeline
    // still publishes the data, and leaves the last sidecars in place
    // (parquet_source/chemduck_sidecars.py). So say when they were built.
    const built = sidecars.generated ? sidecars.generated.slice(0, 10) : 'an unrecorded date';
    const asOf = (manifest as {as_of?: string}).as_of;
    throw new AriiSourceError(
      `The sidecars were built on ${built} from an earlier manifest.json; ` +
        `the export has been republished since${asOf ? ` (as of ${asOf.slice(0, 10)})` : ''}. ` +
        'They are rebuilt by the export pipeline each night it succeeds, or ' +
        'by server/publish_arii.py. Refusing to open stale sidecars: their ' +
        'locations and samples may not match the results.',
    );
  }
  const want = sidecars.source_manifest.partitions.map((p) => p.path);
  const got = (manifest.partitions ?? []).map((p) => p.path);
  if (want.join('\n') !== got.join('\n')) {
    throw new AriiSourceError(
      'manifest.json lists different partitions than the sidecars were built from',
    );
  }
}

interface WasmLike {
  getDb(): {
    registerFileURL(
      name: string,
      url: string,
      proto: DuckDBDataProtocol,
      directIO: boolean,
    ): Promise<void>;
  };
}

function hasGetDb(c: unknown): c is WasmLike {
  return typeof (c as WasmLike)?.getDb === 'function';
}

async function fetchOk(url: string): Promise<Response> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new AriiSourceError(`${resp.status} fetching ${url}`);
  }
  return resp;
}

/**
 * Create the `results` view over the ARII partitions. Run before the
 * ChemDuck SQL, which binds its views to `results` at definition time.
 */
export async function openAriiResults(
  connector: DuckDbConnector,
  opts: {manifestUrl: string; dataBaseUrl: string},
): Promise<AriiSourceInfo> {
  const {manifestUrl, dataBaseUrl} = opts;
  if (!hasGetDb(connector)) {
    throw new AriiSourceError(
      'An ARII source needs the DuckDB-WASM connector (registerFileURL)',
    );
  }

  const sidecars = (await (
    await fetchOk(joinUrl(dataBaseUrl, 'sidecars.json'))
  ).json()) as Sidecars;
  const manifestBytes = await (await fetchOk(manifestUrl)).arrayBuffer();
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  checkSidecarsMatch(sidecars, manifest, await sha256Prefixed(manifestBytes));

  const names = sidecars.source_manifest.partitions.map((p) => p.path);
  const db = connector.getDb();
  for (const name of names) {
    await db.registerFileURL(
      name,
      partitionUrl(manifestUrl, name),
      DuckDBDataProtocol.HTTP,
      false,
    );
  }

  // Footers only: one range request per file, no data pages.
  const footer = await connector.query(`
    SELECT CAST(SUM(num_rows) AS BIGINT) AS n
    FROM parquet_file_metadata(${filesLiteral(names)})
  `);
  const fileRows = Number(footer.toArray()[0]?.n ?? -1);
  if (fileRows !== sidecars.source_manifest.rows) {
    throw new AriiSourceError(
      `The partitions hold ${fileRows.toLocaleString()} rows; the manifest says ` +
        `${sidecars.source_manifest.rows.toLocaleString()}. A partition is ` +
        'missing, truncated or stale; refusing to open it.',
    );
  }

  const template = await (
    await fetchOk(joinUrl(dataBaseUrl, sidecars.results_view.file))
  ).text();
  await connector.query(
    resultsViewSql(template, sidecars.results_view.files_token, names),
  );

  return {
    kind: 'arii',
    facility: sidecars.source_manifest.facility,
    manifestUrl: manifestUrl.split('?')[0]!,
    rows: sidecars.source_manifest.rows,
    partitions: sidecars.source_manifest.partitions,
    sidecarsGenerated: sidecars.generated,
    unplacedLocations: sidecars.coordinates.unplaced_locations,
    chemduckCommit: sidecars.chemduck.commit,
  };
}

/**
 * The partitions' freshness, summarized for display. A partition the
 * export pipeline KEPT from an earlier night carries an older as_of, so
 * the range matters; a manifest that records none says so rather than
 * implying the data is current.
 */
export function describeFreshness(partitions: AriiPartition[]): string {
  const dates = partitions
    .map((p) => p.as_of)
    .filter((d): d is string => Boolean(d))
    .sort();
  if (dates.length === 0) return 'partition dates not recorded';
  const day = (d: string) => d.slice(0, 10);
  const lo = day(dates[0]!);
  const hi = day(dates[dates.length - 1]!);
  const missing = partitions.length - dates.length;
  const span = lo === hi ? `as of ${lo}` : `as of ${lo} to ${hi}`;
  return missing > 0 ? `${span} (${missing} undated)` : span;
}
