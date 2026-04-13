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
 * - `geoparquet` (point geometry only) — assumes the table has been
 *   registered into DuckDB-WASM by an external loader (not yet wired)
 *   and that the spatial extension is loaded. Uses ST_X/ST_Y/ST_Z to
 *   pull coordinates from the WKB geometry column described by
 *   `geometryColumn`, synthesizes a stable id from `idColumn` (or the
 *   row number when null), and passes through any `propertiesColumns`
 *   for click-to-attributes. CRS reprojection is the loader's job —
 *   the dispatcher assumes the registered table is already in WGS84.
 *
 * - `geoparquet` (line / polygon / multi*) — returns null. These
 *   geometry types are reserved for a future vector renderer that
 *   will convert WKB → Cesium polyline/polygon entities (probably
 *   via ST_AsGeoJSON for simplicity). The entity-layer dispatcher in
 *   ChemroomsEntityLayers skips null SQL, so non-point geoparquet
 *   layers won't render at all until that renderer is built.
 *
 * - `geojson`, `geojson-inline`, `imagery` — don't go through the
 *   SQL/entity pipeline at all. Cesium has its own renderers for
 *   them (GeoJsonDataSource, ImageryLayer). Returns null so the
 *   entity-layer pipeline skips them; their renderers will be wired
 *   separately.
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
      const ds = layer.dataSource;

      // Only point geometries flow through the SQL/entity pipeline.
      // Line/polygon variants are reserved for a future vector
      // renderer; returning null here causes the entity-layer
      // dispatcher in ChemroomsEntityLayers to skip this layer.
      if (ds.geometryType !== 'point') {
        return null;
      }

      const tableIdent = quoteIdent(ds.tableName);
      const geomIdent = quoteIdent(ds.geometryColumn);

      // Identity: an explicit idColumn beats a synthesized row number.
      // The synthesized form uses ROW_NUMBER() so freshly dropped-in
      // files render without the user having to specify anything,
      // and the entity ids stay stable across re-queries because
      // ROW_NUMBER() is deterministic over a sorted table.
      const idExpr = ds.idColumn
        ? quoteIdent(ds.idColumn)
        : `('row-' || ROW_NUMBER() OVER ())`;

      // Label: explicit labelColumn > idColumn > synthesized id.
      const labelExpr = ds.labelColumn
        ? quoteIdent(ds.labelColumn)
        : ds.idColumn
          ? quoteIdent(ds.idColumn)
          : `('row-' || ROW_NUMBER() OVER ())`;

      // Altitude: pull Z when the geometry is 3D, otherwise NULL
      // (entity falls back to terrain-clamped rendering).
      const altExpr = ds.is3d ? `ST_Z(${geomIdent})` : 'NULL';

      // Properties: each column listed in propertiesColumns becomes
      // a passthrough in the SELECT so the entity renderer can
      // attach them for click-to-attributes. Sanitized identically
      // to tableName.
      const propsSelect =
        ds.propertiesColumns.length > 0
          ? ',\n  ' + ds.propertiesColumns.map(quoteIdent).join(',\n  ')
          : '';

      return `
        SELECT
          ${idExpr} AS location_id,
          ST_X(${geomIdent}) AS longitude,
          ST_Y(${geomIdent}) AS latitude,
          ${altExpr} AS altitude,
          ${labelExpr} AS label${propsSelect}
        FROM ${tableIdent}
      `;
    }

    case 'geojson':
    case 'geojson-inline':
    case 'imagery':
      // Not handled by the SQL/entity pipeline.
      return null;
  }
}
