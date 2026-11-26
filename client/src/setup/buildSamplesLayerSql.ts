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
 *   Calls ChemDuck's `aggregate_points(...)` (its shared rules) with the
 *   user's filters, event choice and non-detect display. The result is
 *   one row per measurement point: (location_id, matrix, top_depth,
 *   bottom_depth, position, fraction, meas_basis, method_class). Dissolved
 *   and total are never combined, and neither are a field and a lab
 *   method, so with no fraction or method-class filter a location yields
 *   one row (and one entity) per fraction and class. `result` is the
 *   selected value, a non-detect drawn by the display factor; `detected`,
 *   `n_events` etc. feed the vis spec color pipeline, and the provenance
 *   columns (selected_by, limit_source, nd_policy, ...) the inspector.
 *
 *   It used to call `aggregate_results(...)` with ChemDuck 0.1's recipe
 *   (dup_agg, nd_method), which ChemDuck kept only for Chemrooms: it
 *   averaged a day's samples, a substituted non-detect among them, and
 *   called the average detected.
 *
 * Depth is converted to metres per depth interval from samples'
 * depth_units, through `depth_interval_units` (built at init, see
 * initEntityLayers). It used to be multiplied by 0.3048 everywhere, which
 * drew a metre-unit facility at 30% of its depth and centimetre samples
 * 100x too deep. An interval whose unit is unknown gets no depth (rendered
 * at the surface) rather than a guessed one. aggregate_points keys points
 * on the raw depth values, so they are converted here, at render time, and
 * never rewritten in the table.
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
  /** most_recent | maximum | mean (statistic) — used only when analyte is set. */
  eventAgg: string;
  /**
   * Method class to map, or null for every class, each its own point (a
   * field and a lab pH are two variables). Used only when analyte is set.
   */
  methodClass?: string | null;
  /** Non-detect display (ndDisplay.ts) — used only when analyte is set. */
  ndMethod: string;
  /** Active matrix filter, or null for "all matrices". */
  matrixFilter: string | null;
  /**
   * Active fraction filter, or null for "every fraction, each its own
   * entity". Passed to aggregate_points as p_fraction.
   */
  fractionFilter?: string | null;
  /**
   * No-analyte view only: draw one entity per sampling point (location,
   * matrix, depth interval) instead of one per sample. Set for projects
   * above SAMPLE_ENTITY_LIMIT samples.
   */
  groupSamples?: boolean;
}

/**
 * Above this many drawable samples the no-analyte view groups samples into
 * sampling points. One Cesium entity per sample is fine for the demo
 * (9,940 samples) but not for an EQuIS facility: the test facility's 104,540 samples
 * made 105,245 entities and kept the main thread busy for minutes, with the
 * analyte picker unusable. They sit at 3,888 distinct points - a station
 * resampled for years is one place - so grouping loses nothing visible.
 */
export const SAMPLE_ENTITY_LIMIT = 20000;

import {ndDisplayFactor, ndHides, normalizeEventAgg} from './ndDisplay';

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

/**
 * Metres for a depth value, given its interval's factor `f` (NULL when the
 * unit is unknown). Zero is zero in any unit, so a surface sample (0, 0)
 * stays at the surface even when its unit was never recorded.
 */
function depthM(value: string, factor: string): string {
  return `CASE WHEN ${value} = 0 THEN 0.0 ELSE ${value} * ${factor} END`;
}

export function buildSamplesLayerSql(
  opts: BuildSamplesLayerSqlOptions,
): string {
  const {
    elevationColumns,
    coloringAnalyte,
    eventAgg,
    methodClass = null,
    ndMethod,
    matrixFilter,
    fractionFilter = null,
    groupSamples = false,
  } = opts;

  // ── No analyte, large project: one entity per sampling point. ───────────
  // Composite id as the aggregate path builds it, so a click opens the
  // location in the inspector.
  if (!coloringAnalyte && groupSamples) {
    const surveyedSampleParent = surveyedElevExpr(elevationColumns, 'l.');
    return `
      WITH pts AS (
        SELECT
          s.location_id,
          s.matrix,
          COALESCE(s.top_depth, 0) AS top_depth,
          COALESCE(s.bottom_depth, 0) AS bottom_depth,
          avg(s.depth) AS depth,
          count(*)::INTEGER AS sample_count,
          min(s.sample_date) AS first_sample_date,
          max(s.sample_date) AS last_sample_date
        FROM samples s
        GROUP BY 1, 2, 3, 4
      )
      SELECT
        pts.location_id || '|' || pts.matrix
          || '|' || CAST(pts.top_depth AS VARCHAR)
          || '|' || CAST(pts.bottom_depth AS VARCHAR) || '||' AS location_id,
        l.x AS longitude,
        l.y AS latitude,
        COALESCE(
          ${surveyedSampleParent} + geoid_offset(l.x, l.y),
          es.ellipsoidal_height_m,
          0.0
        ) - COALESCE(
          ${depthM('COALESCE(pts.depth, (pts.top_depth + pts.bottom_depth) / 2.0)', 'du.to_m')},
          0
        ) AS altitude,
        pts.matrix AS loc_type,
        COALESCE(l.loc_desc, pts.location_id) || ' (' || pts.sample_count || ' sample'
          || CASE WHEN pts.sample_count = 1 THEN '' ELSE 's' END
          || CASE WHEN pts.top_depth = 0 AND pts.bottom_depth = 0 THEN ''
               ELSE ', ' || pts.top_depth || '–' || pts.bottom_depth || COALESCE(' ' || du.depth_units, '')
             END || ')' AS label,
        pts.matrix,
        pts.sample_count,
        pts.first_sample_date,
        pts.last_sample_date,
        du.depth_units
      FROM pts
      JOIN locations l ON l.location_id = pts.location_id
      LEFT JOIN location_elevations_sampled es
        ON es.location_id = l.location_id
      LEFT JOIN depth_interval_units du
        ON du.location_id = pts.location_id
       AND du.matrix = pts.matrix
       AND du.top_depth = pts.top_depth
       AND du.bottom_depth = pts.bottom_depth
      WHERE l.x IS NOT NULL AND l.y IS NOT NULL
    `;
  }

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
        ) - COALESCE(${depthM('s.depth', 'depth_unit_to_m(s.depth_units)')}, 0) AS altitude,
        s.matrix AS loc_type,
        s.sample_id || CASE
          WHEN s.depth IS NULL THEN ' (surface)'
          ELSE ' (' || ROUND(s.depth, 1) || COALESCE(' ' || s.depth_units, '') || ')'
        END AS label
      FROM samples s
      JOIN locations l ON l.location_id = s.location_id
      LEFT JOIN location_elevations_sampled es
        ON es.location_id = l.location_id
      WHERE l.x IS NOT NULL AND l.y IS NOT NULL
    `;
  }

  // ── Analyte selected: ChemDuck's aggregate_points, one row per point. ────
  // The point's value, which result it is, and how a non-detect among them
  // is valued are ChemDuck's shared rules and the dataset's non-detect
  // policy (ndDisplay.ts). Mixed units in the variable are refused there,
  // with an error naming them, and the error reaches the user (mapNotice).
  const factor = ndDisplayFactor(ndMethod);
  const args = [
    sqlStr(coloringAnalyte),
    `p_event_agg := ${sqlStr(normalizeEventAgg(eventAgg))}`,
    matrixFilter ? `p_matrix := ${sqlStr(matrixFilter)}` : null,
    fractionFilter ? `p_fraction := ${sqlStr(fractionFilter)}` : null,
    methodClass ? `p_method_class := ${sqlStr(methodClass)}` : null,
    factor !== null ? `p_display_factor := ${factor}` : null,
  ].filter((a): a is string => a !== null);
  const hideNonDetects = ndHides(ndMethod) ? 'AND agg.detected IS DISTINCT FROM FALSE' : '';

  // Locations are joined back in to get the NAVD88 elevation columns for
  // the altitude resolution. aggregate_points already has x/y — we only
  // need the elevation column values from the source locations table.
  const surveyedSampleParent = surveyedElevExpr(elevationColumns, 'l.');
  const surface = `COALESCE(
        ${surveyedSampleParent} + geoid_offset(agg.x, agg.y),
        es.ellipsoidal_height_m,
        0.0
      )`;

  return `
    WITH agg AS (
      SELECT * EXCLUDE (top_depth, bottom_depth),
        COALESCE(top_depth, 0) AS top_depth,
        COALESCE(bottom_depth, 0) AS bottom_depth
      FROM aggregate_points(
        ${args.join(',\n        ')}
      )
    )
    SELECT
      -- One entity per measurement point (shared rules D1, D3): location,
      -- matrix, depth interval, fraction, basis, then position and method
      -- class. The first six keep the order older ids and bookmarks use
      -- (parseCompositeLocationId).
      agg.location_id || '|' || agg.matrix
        || '|' || CAST(agg.top_depth AS VARCHAR)
        || '|' || CAST(agg.bottom_depth AS VARCHAR)
        || '|' || COALESCE(agg.fraction, '')
        || '|' || COALESCE(agg.meas_basis, '')
        || '|' || COALESCE(agg.position, '')
        || '|' || COALESCE(agg.method_class, '') AS location_id,
      agg.x AS longitude,
      agg.y AS latitude,
      -- Surface elevation before depth subtraction. The renderer uses
      -- this + the depth interval to fabricate a 3D trajectory for
      -- polylineVolume rendering. Kept separate from altitude so the
      -- desurvey logic can do its own math.
      ${surface} AS surface_elev_m,
      -- Midpoint altitude for backward compat with the sphere/point path.
      ${surface} - COALESCE(
        ${depthM('COALESCE(agg.depth, (agg.top_depth + agg.bottom_depth) / 2.0)', 'du.to_m')},
        0
      ) AS altitude,
      -- Depth interval endpoints in meters below collar. The renderer
      -- uses these with surface_elev_m and the desurvey function to
      -- produce polylineVolume positions. Null when the sample has no
      -- depth info, or its depth unit is unknown (rendered as sphere).
      ${depthM('agg.top_depth', 'du.to_m')} AS top_depth_m,
      ${depthM('agg.bottom_depth', 'du.to_m')} AS bottom_depth_m,
      du.depth_units,
      agg.matrix AS loc_type,
      -- A non-detect is labelled as one: '<' and the value it is drawn at.
      agg.location_id || ' — ' || agg.analyte
        || COALESCE(' ' || agg.fraction, '')
        || ' (' || CASE WHEN agg.detected IS FALSE THEN '<' ELSE '' END
        || ROUND(agg.result, 3) || COALESCE(' ' || agg.units, '') || ')'
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
      agg.units_conflict,
      agg.detection_limit,
      agg.fraction,
      agg.meas_basis,
      agg.matrix,
      agg.position,
      agg.method_class,
      -- Provenance: which result the point shows, and why (inspector).
      agg.sample_id,
      agg.method_code,
      agg.selected_by,
      agg.limit_source,
      agg.nd_policy,
      agg.display_factor,
      agg.unit_source,
      array_to_string(agg.filters_ignored, ', ') AS filters_ignored
    FROM agg
    JOIN locations l ON l.location_id = agg.location_id
    LEFT JOIN location_elevations_sampled es
      ON es.location_id = agg.location_id
    LEFT JOIN depth_interval_units du
      ON du.location_id = agg.location_id
     AND du.matrix = agg.matrix
     AND du.top_depth = agg.top_depth
     AND du.bottom_depth = agg.bottom_depth
    WHERE agg.x IS NOT NULL AND agg.y IS NOT NULL
      ${hideNonDetects}
  `;
}
