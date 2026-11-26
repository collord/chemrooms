/**
 * The app's own DuckDB-WASM, in Node, for tests that need the real engine
 * (the version SQLRooms runs in the browser, not the Python DuckDB the
 * server scripts use). Test files using it need `// @vitest-environment
 * node`: under happy-dom the WASM fails with "null function or function
 * signature mismatch".
 */

import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);

/** server/data, the demo ChemDuck folder. */
export const DEMO_DATA = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../server/data',
);

export interface WasmDb {
  /** Run SQL; rows as plain objects. */
  rows: (sql: string) => Record<string, unknown>[];
  /** Run SQL for its effect. */
  run: (sql: string) => void;
  /** CREATE TABLE <name> from a local parquet file. */
  loadParquet: (name: string, file: string) => void;
  close: () => void;
}

export async function openWasmDb(): Promise<WasmDb> {
  const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dist = path.dirname(entry);
  const duckdb = require(entry);
  const db = await duckdb.createDuckDB(
    {
      mvp: {mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: ''},
      eh: {mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: ''},
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate(() => {});
  db.open({});
  const conn = db.connect();
  return {
    rows: (sql) => conn.query(sql).toArray().map((r: any) => r.toJSON()),
    run: (sql) => void conn.query(sql),
    loadParquet: (name, file) => {
      db.registerFileBuffer(`${name}.parquet`, new Uint8Array(readFileSync(file)));
      conn.query(`CREATE TABLE ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
    },
    close: () => conn.close(),
  };
}
