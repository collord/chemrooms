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
