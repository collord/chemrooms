/**
 * Per-layer SQL dispatcher.
 *
 * Takes a LayerConfig and produces the SELECT that the entity rendering
 * pipeline will execute. Branches on `dataSource.type` so each variant
 * of the typed-reference union maps to its own SQL builder.
 *
 * This is the load-bearing test of the typed-reference system: if the
 * schema is shape-correct, adding a new data source means adding one
 * branch here and the rest of the pipeline doesn't have to change.
 *
 * ## Current branches
 *
 * - `chemduck` — delegates to buildSamplesLayerSql, the chemduck recipe
 *   builder. Requires `query` to be set; returns null otherwise.
 *
 * - `geoparquet` — assumes the table has been registered into DuckDB-WASM
 *   by an external loader (not yet wired) under `dataSource.tableName`,
 *   and that the parquet has columns matching the entity-rendering
 *   contract: `location_id`, `longitude`, `latitude`, `altitude`, `label`.
 *   Schema heterogeneity (parquets with arbitrary column names) is the
 *   next design problem — see TODO below.
 *
 * - `geojson`, `geojson-inline`, `imagery` — these don't go through the
 *   SQL/entity pipeline. Cesium has its own renderers for them
 *   (GeoJsonDataSource, ImageryLayer). Returns null so the entity-layer
 *   pipeline skips them; their renderers will be wired separately.
 *
 * ## TODO: parquet column mapping
 *
 * The current `geoparquet` branch hardcodes the canonical column names.
 * Real geoparquet files in the wild won't always have those names — a
 * regulator's wells.parquet might use `lon`/`lat`/`well_id`. The next
 * design step is to either (a) extend GeoParquetDataSource with a
 * `columnMap` field, (b) load a vis-spec sidecar alongside the parquet,
 * or (c) introspect the parquet schema at registration time and try to
 * auto-detect canonical roles. (c) is the most magical but also the
 * most fragile; (a) is the most explicit. This decision needs to be
 * made before the runtime loader is wired.
 */

import type {LayerConfig} from './layerSchema';
import {buildSamplesLayerSql} from '../setup/buildSamplesLayerSql';

export interface BuildLayerSqlContext {
  /** Columns on `locations` that may hold a NAVD88 elevation. */
  elevationColumns: string[];
}

/**
 * Quote an identifier for safe inclusion in a SQL FROM clause.
 * DuckDB uses double quotes around identifiers. We strip anything
 * that isn't a safe identifier character first as a defense-in-depth
 * measure against tableName values that came from a layer config we
 * didn't author.
 */
function quoteIdent(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '');
  return `"${cleaned}"`;
}

export function buildLayerSql(
  layer: LayerConfig,
  ctx: BuildLayerSqlContext,
): string | null {
  switch (layer.dataSource.type) {
    case 'chemduck': {
      // Chemduck layers must have a query — without one there's no
      // recipe to render. The freeze flow always sets it, but loaded
      // configs might omit it.
      if (!layer.query) return null;
      return buildSamplesLayerSql({
        elevationColumns: ctx.elevationColumns,
        coloringAnalyte: layer.query.analyte,
        eventAgg: layer.query.eventAgg,
        dupAgg: layer.query.dupAgg,
        ndMethod: layer.query.ndMethod,
        matrixFilter: layer.query.matrix,
      });
    }

    case 'geoparquet': {
      // See TODO above on column mapping. For now we assume the parquet
      // has the canonical entity-pipeline columns.
      const ident = quoteIdent(layer.dataSource.tableName);
      return `
        SELECT
          location_id,
          longitude,
          latitude,
          altitude,
          label
        FROM ${ident}
      `;
    }

    case 'geojson':
    case 'geojson-inline':
    case 'imagery':
      // Not handled by the SQL/entity pipeline.
      return null;
  }
}
