/**
 * Builds the SQL for the samples entity layer.
 *
 * Two modes:
 *
 * - **No analyte selected** (fallback):
 *   Returns the existing "one entity per sample from the samples table"
 *   query that was the original layer. No aggregation, no joined result
 *   columns, just every physical sample point. Used when the user
 *   hasn't picked an analyte yet and we want to show the full extent
 *   of the data so they can click individual points.
 *
 * - **Analyte selected**:
 *   Calls chemduck's `aggregate_results(...)` table macro with the
 *   user's filter + aggregation rule choices. The result is one row
 *   per (location_id, matrix, top_depth, bottom_depth) partition,
 *   with `result` (the aggregated, ND-adjusted value), `detected`,
 *   `sample_date`, `n_events`, etc. available for the vis spec
 *   color pipeline.
 *
 * In both modes the SQL is wrapped with the chemrooms altitude
 * resolution (geoid-corrected surveyed elevation or terrain sample)
 * so entities render at the right ellipsoidal height.
 */

interface BuildSamplesLayerSqlOptions {
  /** Columns on `locations` that may hold a NAVD88 elevation. */
  elevationColumns: string[];
  /** Currently selected analyte, or null for the fallback query. */
  coloringAnalyte: string | null;
  /** aggregation_rules event_agg name — used only when analyte is set. */
  eventAgg: string;
  /** aggregation_rules dup_agg name — used only when analyte is set. */
  dupAgg: string;
  /** aggregation_rules nd_method name — used only when analyte is set. */
  ndMethod: string;
  /** Active matrix filter, or null for "all matrices". */
  matrixFilter: string | null;
}

/** Single-quote an SQL literal safely. */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Like surveyedElevExpr in initEntityLayers, but exported for reuse. */
function surveyedElevExpr(elevationColumns: string[], prefix: string): string {
  if (elevationColumns.length === 0) return 'CAST(NULL AS DOUBLE)';
  const cols = elevationColumns.map((c) => `${prefix}${c}`);
  return `COALESCE(${cols.join(', ')})`;
}

export function buildSamplesLayerSql(
  opts: BuildSamplesLayerSqlOptions,
): string {
  const {
    elevationColumns,
    coloringAnalyte,
    eventAgg,
    dupAgg,
    ndMethod,
    matrixFilter,
  } = opts;

  // ── No analyte: show every sample, cyan, no aggregation. ─────────────────
  if (!coloringAnalyte) {
    const surveyedSampleParent = surveyedElevExpr(elevationColumns, 'l.');
    return `
      SELECT
        s.sample_id AS location_id,
        l.x AS longitude,
        l.y AS latitude,
        COALESCE(
          ${surveyedSampleParent} + geoid_offset(l.x, l.y),
          es.ellipsoidal_height_m,
          0.0
        ) - (COALESCE(s.depth, 0) * 0.3048) AS altitude,
        s.matrix AS loc_type,
        s.sample_id || CASE
          WHEN s.depth IS NULL THEN ' (surface)'
          ELSE ' (' || ROUND(s.depth, 1) || ' ft)'
        END AS label
      FROM samples s
      JOIN locations l ON l.location_id = s.location_id
      LEFT JOIN location_elevations_sampled es
        ON es.location_id = l.location_id
    `;
  }

  // ── Analyte selected: use chemduck aggregate_results table macro. ────────
  const analyteLit = sqlStr(coloringAnalyte);
  const matrixLit = matrixFilter ? sqlStr(matrixFilter) : 'NULL';
  const eventAggLit = sqlStr(eventAgg);
  const dupAggLit = sqlStr(dupAgg);
  const ndMethodLit = sqlStr(ndMethod);

  // Locations are joined back in to get the NAVD88 elevation columns for
  // the altitude resolution. aggregate_results already has x/y — we only
  // need the elevation column values from the source locations table.
  const surveyedSampleParent = surveyedElevExpr(elevationColumns, 'l.');

  return `
    WITH agg AS (
      SELECT *
      FROM aggregate_results(
        ${analyteLit},
        ${matrixLit},
        NULL,
        NULL,
        ${eventAggLit},
        ${dupAggLit},
        ${ndMethodLit},
        0.0,
        1.0
      )
    )
    SELECT
      agg.location_id || '|' || agg.matrix
        || '|' || CAST(agg.top_depth AS VARCHAR)
        || '|' || CAST(agg.bottom_depth AS VARCHAR) AS location_id,
      agg.x AS longitude,
      agg.y AS latitude,
      COALESCE(
        ${surveyedSampleParent} + geoid_offset(agg.x, agg.y),
        es.ellipsoidal_height_m,
        0.0
      ) - (COALESCE(agg.depth, (agg.top_depth + agg.bottom_depth) / 2.0, 0) * 0.3048) AS altitude,
      agg.matrix AS loc_type,
      agg.location_id || ' — ' || agg.analyte
        || ' (' || ROUND(agg.result, 3) || COALESCE(' ' || agg.units, '') || ')'
        AS label,
      -- Passthrough columns for the color pipeline
      agg.analyte,
      agg.analyte_group,
      agg.result,
      agg.detected,
      agg.n_events,
      agg.n_detects,
      agg.rep_sample_date,
      agg.first_sample_date,
      agg.last_sample_date,
      agg.units,
      agg.std_units,
      agg.detection_limit,
      agg.matrix
    FROM agg
    JOIN locations l ON l.location_id = agg.location_id
    LEFT JOIN location_elevations_sampled es
      ON es.location_id = agg.location_id
  `;
}
