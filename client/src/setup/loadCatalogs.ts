/**
 * Post-schema-load queries against DuckDB-WASM that populate the
 * chemrooms slice with "catalog" data:
 *
 *   - aggregation_rules   : chemduck enum catalog (drives UI dropdowns)
 *   - availableAnalytes   : sorted list of distinct analytes seen in data
 *
 * These run after initEntityLayers has completed so v_analyte_summary
 * and the aggregation_rules table are both available.
 */

import type {DuckDbConnector} from '@sqlrooms/duckdb';
import type {AggregationRule} from '../slices/chemrooms-slice';

/**
 * Query the aggregation_rules catalog from DuckDB-WASM and return a flat
 * list of rules. Returns an empty array if the table doesn't exist.
 */
export async function loadAggregationRules(
  connector: DuckDbConnector,
): Promise<AggregationRule[]> {
  try {
    const result = await connector.query(`
      SELECT
        category,
        name,
        label,
        description,
        display_order
      FROM aggregation_rules
      ORDER BY category, display_order
    `);
    return result.toArray().map((r: any) => ({
      category: String(r.category),
      name: String(r.name),
      label: String(r.label),
      description: r.description == null ? null : String(r.description),
      displayOrder: Number(r.display_order),
    }));
  } catch (e) {
    console.warn('[init] failed to load aggregation_rules:', e);
    return [];
  }
}

/**
 * The sorted distinct analyte list for the picker, from analyte_catalog
 * (src/sql/chemrooms_catalogs.sql): a live view for a ChemDuck project, a
 * sidecar table for an ARII one. It used to read v_analyte_summary, which
 * groups every result; over remote ARII partitions that downloads the
 * facility to fill a dropdown.
 *
 * Returns [] if the catalog isn't available (e.g., chemduck schema failed
 * to load).
 */
export async function loadAvailableAnalyteNames(
  connector: DuckDbConnector,
): Promise<string[]> {
  try {
    const result = await connector.query(`
      SELECT DISTINCT analyte
      FROM analyte_catalog
      WHERE analyte IS NOT NULL
      ORDER BY analyte
    `);
    return result.toArray().map((r: any) => String(r.analyte));
  } catch (e) {
    console.warn('[init] failed to load analyte names:', e);
    return [];
  }
}
