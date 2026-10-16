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
 *   per measurement identity: (location_id, matrix, top_depth,
 *   bottom_depth, fraction, meas_basis). Dissolved and total are never
 *   combined, so with no fraction filter a location measured both ways
 *   yields one row (and one entity) per fraction. `result` is the
 *   aggregated, ND-adjusted value; `detected`, `n_events` etc. feed the
 *   vis spec color pipeline.
 *
 * Depth is converted to metres per depth interval from samples'
 * depth_units, through `depth_interval_units` (built at init, see
 * initEntityLayers). It used to be multiplied by 0.3048 everywhere, which
 * drew a metre-unit facility at 30% of its depth and centimetre samples
 * 100x too deep. An interval whose unit is unknown gets no depth (rendered
 * at the surface) rather than a guessed one. aggregate_results partitions
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
  /** aggregation_rules event_agg name — used only when analyte is set. */
  eventAgg: string;
  /** aggregation_rules dup_agg name — used only when analyte is set. */
  dupAgg: string;
  /** aggregation_rules nd_method name — used only when analyte is set. */
  ndMethod: string;
  /** Active matrix filter, or null for "all matrices". */
  matrixFilter: string | null;
  /**
   * Active fraction filter, or null for "every fraction, each its own
   * entity". Passed to aggregate_results as p_fraction.
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
    dupAgg,
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

  // ── Analyte selected: use chemduck aggregate_results table macro. ────────
  const analyteLit = sqlStr(coloringAnalyte);
  const matrixLit = matrixFilter ? sqlStr(matrixFilter) : 'NULL';
  const eventAggLit = sqlStr(eventAgg);
  const dupAggLit = sqlStr(dupAgg);
  const ndMethodLit = sqlStr(ndMethod);
  const fractionArg = fractionFilter
    ? `,\n        p_fraction := ${sqlStr(fractionFilter)}`
    : '';

  // Locations are joined back in to get the NAVD88 elevation columns for
  // the altitude resolution. aggregate_results already has x/y — we only
  // need the elevation column values from the source locations table.
  const surveyedSampleParent = surveyedElevExpr(elevationColumns, 'l.');
  const surface = `COALESCE(
        ${surveyedSampleParent} + geoid_offset(agg.x, agg.y),
        es.ellipsoidal_height_m,
        0.0
      )`;

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
        1.0${fractionArg}
      )
    )
    SELECT
      -- One entity per measurement identity. Fraction and basis are part
      -- of it: without them a location measured dissolved and total
      -- produced two entities with one id.
      agg.location_id || '|' || agg.matrix
        || '|' || CAST(agg.top_depth AS VARCHAR)
        || '|' || CAST(agg.bottom_depth AS VARCHAR)
        || '|' || COALESCE(agg.fraction, '')
        || '|' || COALESCE(agg.meas_basis, '') AS location_id,
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
      agg.location_id || ' — ' || agg.analyte
        || COALESCE(' ' || agg.fraction, '')
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
      agg.units_conflict,
      agg.detection_limit,
      agg.fraction,
      agg.meas_basis,
      agg.matrix
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
  `;
}
