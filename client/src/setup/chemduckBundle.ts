/**
 * The ChemDuck SQL bundle in a data folder, and loading it.
 *
 * A data folder carries ChemDuck's SQL beside its data (`sql/`), written by
 * ChemDuck's `write_consumer_bundle`: server/sync_chemduck.py or
 * export_chemduck.py for a ChemDuck folder, `publish` for an ARII one (the
 * QGIS plugin's nightly pipeline, or server/publish_arii.py). `sql/SOURCE.json`
 * names the files, in load order, and the ChemDuck they came from.
 *
 * The client used to fetch four files by name. ChemDuck's bundle grew to
 * seven (08_aggregate_points, 10_sample_results and 11_ism were added), and
 * a client with a fixed list never loaded them. The list is now the
 * folder's own.
 */

/** The parts of sql/SOURCE.json this client reads. */
export interface ChemduckSource {
  chemduck?: {
    version?: string;
    /** Null from a vendored ChemDuck that SOURCE.json was not stamped for. */
    commit?: string | null;
    subject?: string;
  };
  files?: unknown;
}

/**
 * What a folder written before SOURCE.json listed its files carries. Only
 * folders older than ChemDuck's `files` field use it.
 */
export const LEGACY_BUNDLE_FILES = [
  '00_bootstrap.sql',
  '02_macros.sql',
  '03_views.sql',
  '08_aggregate_results.sql',
];

/**
 * Files the app can't work without. The rest are loaded, and a failure is
 * reported, but the app opens: a missing macro fails the query that calls
 * it, loudly, and changes no number another query returns.
 */
export const REQUIRED_BUNDLE_FILES = new Set([
  '00_bootstrap.sql',
  '03_views.sql',
  // aggregate_points, point_series, point_counts: every map and series.
  '08_aggregate_points.sql',
]);

/**
 * Why a bundle can't serve this client, or null when it can: a folder whose
 * ChemDuck SQL predates aggregate_points (the legacy four files) has
 * nothing the maps call. Said once, by name, rather than as a failed query
 * on every analyte picked.
 */
export function bundleTooOld(files: string[]): string | null {
  return files.includes('08_aggregate_points.sql')
    ? null
    : "This data folder's ChemDuck SQL predates aggregate_points, which every map " +
        'now calls. Rewrite it with server/sync_chemduck.py (and re-export the data ' +
        'with server/export_chemduck.py), or republish the sidecars.';
}

const BUNDLE_FILE = /^[0-9]{2}_[a-z0-9_]+\.sql$/;

/**
 * The files to load, in order, from SOURCE.json. Refuses a list that isn't
 * plain file names (the names become URLs), or that doesn't start with the
 * bootstrap, which must run before anything else.
 */
export function bundleFiles(source: ChemduckSource | null): string[] {
  if (!source || source.files === undefined) return LEGACY_BUNDLE_FILES;
  const files = source.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('sql/SOURCE.json: "files" is not a list of SQL files');
  }
  const bad = files.filter((f) => typeof f !== 'string' || !BUNDLE_FILE.test(f));
  if (bad.length) {
    throw new Error(`sql/SOURCE.json lists files that are not bundle SQL: ${bad.join(', ')}`);
  }
  if (files[0] !== '00_bootstrap.sql') {
    throw new Error('sql/SOURCE.json does not list 00_bootstrap.sql first');
  }
  return files as string[];
}

export interface BundleLoadResult {
  /** Every file loaded. */
  ok: boolean;
  /** Every required file loaded: the app can open. */
  usable: boolean;
  /** Files that still failed after every retry, with their last error. */
  failed: {file: string; error: string}[];
}

/**
 * Run the bundle's files against a connection, as ChemDuck's own
 * `load_consumer_sql` does: in order, then again for whatever failed, until
 * everything loads or a round makes no progress.
 *
 * The retry is needed because macros and views refer to each other across
 * files. 02_macros has macros that read v_results_denormalized, which
 * 03_views defines, and the views use 02's simpler macros. DuckDB 1.5 and
 * 2.0 refuse such a macro when it is defined; 1.4 accepts it. Each file is
 * one multi-statement query, so a failed file has defined whatever came
 * before its failing statement. Every statement outside the bootstrap is
 * CREATE OR REPLACE, so running a file again is safe.
 *
 * The bootstrap is never retried. It creates the tables the views read,
 * and its seed INSERTs must run once.
 */
export async function loadBundle(
  files: string[],
  sqlOf: (file: string) => string,
  query: (sql: string) => PromiseLike<unknown>,
): Promise<BundleLoadResult> {
  const [bootstrap, ...rest] = files;
  try {
    await query(sqlOf(bootstrap));
  } catch (e) {
    return {ok: false, usable: false, failed: [{file: bootstrap, error: String(e)}]};
  }
  let pending = rest;
  const errors = new Map<string, string>();
  for (;;) {
    const still: string[] = [];
    for (const file of pending) {
      try {
        await query(sqlOf(file));
        errors.delete(file);
      } catch (e) {
        errors.set(file, String(e));
        still.push(file);
      }
    }
    if (still.length === 0 || still.length === pending.length) {
      pending = still;
      break;
    }
    pending = still;
  }
  const failed = pending.map((file) => ({file, error: errors.get(file) ?? ''}));
  return {
    ok: failed.length === 0,
    usable: !failed.some((f) => REQUIRED_BUNDLE_FILES.has(f.file)),
    failed,
  };
}
