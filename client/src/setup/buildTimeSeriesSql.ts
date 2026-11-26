/**
 * The time-series chart's query: ChemDuck's point_series for one location.
 *
 * Every sample of every measurement point at the location, its re-runs
 * resolved by the dataset's non-detect policy exactly as the map resolves
 * them (point_series is aggregate_points with each sample its own point),
 * a non-detect drawn by the same display choice as the map (ndDisplay.ts).
 *
 * One line per point: a profile station's depth intervals, a field and a
 * lab method, and dissolved and total are separate lines, never one line
 * zig-zagging between them. A line's name carries only the parts that
 * tell it apart from the location's other lines for the same analyte.
 *
 * It used to be its own SQL over `results`: a second copy of the non-detect
 * rules (its own limit chain, no re-run choice, no reportable flag), and
 * every point at the location interleaved into one line per analyte.
 */

import {ndDisplayFactor, ndHides} from './ndDisplay';
import {rowScopeArgs, type RowScope} from './rowScope';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface TimeSeriesQueryOptions {
  locationId: string;
  analytes: string[];
  matrixFilter: string | null;
  fractionFilter: string | null;
  ndMethod: string;
  /** The map's row scope (rowScope.ts): the chart reads the same rows. */
  rowScope?: RowScope | null;
}

export function buildTimeSeriesSql(opts: TimeSeriesQueryOptions): string {
  const {locationId, analytes, matrixFilter, fractionFilter, ndMethod, rowScope = null} = opts;
  const factor = ndDisplayFactor(ndMethod);
  const calls = analytes.map((a) => {
    const args = [
      lit(a),
      `p_locations := [${lit(locationId)}]`,
      matrixFilter ? `p_matrix := ${lit(matrixFilter)}` : null,
      fractionFilter ? `p_fraction := ${lit(fractionFilter)}` : null,
      factor !== null ? `p_display_factor := ${factor}` : null,
      ...rowScopeArgs(rowScope),
    ].filter((x): x is string => x !== null);
    return `SELECT * FROM point_series(${args.join(', ')})`;
  });

  // The parts of a point's key, as label text; '' when absent.
  const depthText = `CASE WHEN COALESCE(top_depth, 0) = 0 AND COALESCE(bottom_depth, 0) = 0 THEN ''
      ELSE CAST(top_depth AS VARCHAR) || '–' || CAST(bottom_depth AS VARCHAR) END`;

  // sample_date: cast to VARCHAR → ISO 8601 string that Observable Plot
  // can parse as temporal. DuckDB's typed DATE over Arrow serializes as
  // epoch integers which the plot engine can't handle.
  //
  // plot_value: explicit CAST to DOUBLE so the axis is numeric, not
  // string-sorted.
  return `
    WITH s AS (
      ${calls.join('\n      UNION ALL BY NAME\n      ')}
    ),
    keyed AS (
      SELECT *,
        COALESCE(fraction, '') AS k_fraction,
        ${depthText} AS k_depth,
        COALESCE(position, '') AS k_position,
        COALESCE(method_class, '') AS k_method
      FROM s
      ${ndHides(ndMethod) ? 'WHERE detected IS DISTINCT FROM FALSE' : ''}
    ),
    -- Which parts vary among an analyte's points at this location: only
    -- those go in the line's name.
    varies AS (
      SELECT analyte,
        count(DISTINCT k_fraction) > 1 AS by_fraction,
        count(DISTINCT k_depth) > 1 AS by_depth,
        count(DISTINCT k_position) > 1 AS by_position,
        count(DISTINCT k_method) > 1 AS by_method,
        count(DISTINCT matrix) > 1 AS by_matrix
      FROM keyed GROUP BY analyte
    )
    SELECT
      k.analyte
        || CASE WHEN v.by_matrix THEN ' ' || k.matrix ELSE '' END
        || CASE WHEN v.by_fraction AND k.k_fraction <> '' THEN ' ' || k.k_fraction ELSE '' END
        || CASE WHEN v.by_depth AND k.k_depth <> '' THEN ' ' || k.k_depth ELSE '' END
        || CASE WHEN v.by_position AND k.k_position <> '' THEN ' ' || k.k_position ELSE '' END
        || CASE WHEN v.by_method AND k.k_method <> '' THEN ' (' || k.k_method || ')' ELSE '' END
        AS series,
      k.analyte,
      CAST(k.sample_date AS VARCHAR) AS sample_date,
      CAST(k.result AS DOUBLE) AS plot_value,
      k.detected,
      k.detection_limit,
      COALESCE(k.units, '') AS units,
      CASE WHEN k.detected IS FALSE THEN 'Non-detect'
           WHEN k.detected IS NULL THEN 'Unknown'
           ELSE 'Detected' END AS detect_status,
      k.sample_id,
      k.method_code
    FROM keyed k JOIN varies v USING (analyte)
    ORDER BY series, k.sample_date, k.sample_id
  `;
}
