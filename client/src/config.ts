/**
 * Deployment configuration read from Vite env vars.
 *
 * Kept in its own module so setup code can read it without importing the
 * room store (which would create an import cycle through the panels).
 */

/**
 * Base URL of the project's data folder: the ChemDuck parquet tables, their
 * vis-spec sidecars, and the ChemDuck SQL under `sql/`. The SQL travels with
 * the data because it is versioned with the schema the parquet was written
 * in, not with the client.
 */
export const DATA_BASE_URL: string =
  import.meta.env.VITE_DATA_URL ?? 'http://localhost:8000/data';

/**
 * URL of an EQuIS ARII export's manifest.json (from the equis-parquet-export
 * pipeline). When set, the project is an ARII source: DATA_BASE_URL is the
 * folder chemduck's `arii_hybrid.py publish` wrote (sidecars, ChemDuck SQL,
 * sidecars.json), and `results` is a view over the manifest's partitions,
 * read by HTTP range requests where they were published.
 *
 * A signed URL (e.g. an Azure SAS) may carry its token in the query string;
 * it is appended to each partition URL and never written into a view.
 *
 * Unset: a converted ChemDuck project, every table a parquet file under
 * DATA_BASE_URL.
 */
export const ARII_MANIFEST_URL: string | null =
  import.meta.env.VITE_ARII_MANIFEST_URL || null;
