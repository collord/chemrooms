-- ChemDuck Schema: Core Macros
-- Phase 1.7-1.10: Reusable business logic

-- ============================================================================
-- 1.7 nd_adjusted_result - Non-detect substitution strategies
-- ============================================================================
-- Handles various methods for treating non-detect values in aggregations.
-- The detection_limit parameter should be the applicable limit for ND
-- substitution. When calling from v_results_denormalized, use the computed
-- 'detection_limit' column which is COALESCE(reporting_limit,
-- method_detection_limit, quantitation_limit).
-- Methods:
--   'raw'        - Use reported value as-is
--   'fixed'      - Substitute a fixed value
--   'multiplier' - Multiply detection limit by a factor
--   'half_dl'    - Use half the detection limit (common default)
--   'zero'       - Substitute zero
--   'dl'         - Use the detection limit

CREATE OR REPLACE MACRO nd_adjusted_result(
    result,
    detected,
    detection_limit,
    method,
    fixed_val,
    multiplier
) AS (
    CASE
        WHEN detected THEN result
        WHEN method = 'raw' THEN result
        WHEN method = 'fixed' THEN fixed_val
        WHEN method = 'multiplier' THEN detection_limit * multiplier
        WHEN method = 'half_dl' THEN detection_limit * 0.5
        WHEN method = 'zero' THEN 0.0
        WHEN method = 'dl' THEN detection_limit
        ELSE result  -- default: use reported value
    END
);

-- ============================================================================
-- 1.8 dv_qualifier - Data validation qualifier derivation
-- ============================================================================
-- Derives standard EPA data validation qualifiers from detect/estimate flags
-- U  = Non-detect (undetected)
-- J  = Estimated value
-- UJ = Non-detect with estimated detection limit

CREATE OR REPLACE MACRO dv_qualifier(detected, estimated) AS (
    CASE
        WHEN NOT detected AND estimated THEN 'UJ'
        WHEN NOT detected THEN 'U'
        WHEN estimated THEN 'J'
        ELSE ''
    END
);

-- ============================================================================
-- 1.9 depth_in_range - Depth filter evaluation
-- ============================================================================
-- Evaluates whether a sample falls within a specified depth interval
-- NULL filter values are treated as "no constraint"

CREATE OR REPLACE MACRO depth_in_range(
    top_depth,
    bottom_depth,
    filter_top,
    filter_bottom
) AS (
    (filter_top IS NULL OR top_depth >= filter_top) AND
    (filter_bottom IS NULL OR bottom_depth <= filter_bottom)
);

-- ============================================================================
-- 1.10 duplicate_aggregate - Duplicate resolution
-- ============================================================================
-- Resolves duplicate measurements using specified aggregation method
-- Takes a list of values and returns single aggregated value

CREATE OR REPLACE MACRO duplicate_aggregate(
    val_list,
    method
) AS (
    CASE method
        WHEN 'min' THEN list_min(val_list)
        WHEN 'max' THEN list_max(val_list)
        WHEN 'avg' THEN list_avg(val_list)
        WHEN 'first' THEN val_list[1]
        WHEN 'last' THEN val_list[len(val_list)]
        ELSE list_avg(val_list)  -- default to average
    END
);

-- ============================================================================
-- Additional utility macros
-- ============================================================================

-- Convert units using the unit_conversions table
-- Note: This requires a scalar subquery which may have performance implications
-- Consider pre-joining unit conversions in views for better performance
CREATE OR REPLACE MACRO convert_units_factor(from_u, to_u) AS (
    COALESCE(
        (SELECT multiplier FROM unit_conversions uc
         WHERE uc.from_units = from_u AND uc.to_units = to_u
         LIMIT 1),
        1.0
    )
);

-- Apply a unit conversion directly to a numeric value
CREATE OR REPLACE MACRO convert_units(
    value,
    from_units,
    to_units
) AS (
    CASE
        WHEN value IS NULL THEN NULL
        WHEN from_units IS NULL OR to_units IS NULL OR from_units = to_units THEN value
        ELSE value * convert_units_factor(from_units, to_units)
    END
);

-- Approximate standard normal cumulative distribution function
CREATE OR REPLACE MACRO normal_cdf(z) AS (
    CASE
        WHEN z IS NULL THEN NULL
        ELSE (
            WITH vars AS (
                SELECT
                    ABS(z) AS abs_z,
                    CASE WHEN z >= 0 THEN TRUE ELSE FALSE END AS is_nonneg
            ),
            components AS (
                SELECT
                    abs_z,
                    is_nonneg,
                    1.0 / (1.0 + 0.2316419 * abs_z) AS t,
                    0.3989422804014327 * EXP(-0.5 * abs_z * abs_z) AS pdf
                FROM vars
            ),
            tail AS (
                SELECT
                    pdf * t * (
                        0.319381530 +
                        t * (-0.356563782 +
                        t * (1.781477937 +
                        t * (-1.821255978 +
                        t * 1.330274429)))
                    ) AS tail_prob,
                    is_nonneg
                FROM components
            )
            SELECT CASE
                WHEN is_nonneg THEN 1 - tail_prob
                ELSE tail_prob
            END
            FROM tail
        )
    END
);

-- Generate a duplicate ID for identifying co-located/co-temporal samples
CREATE OR REPLACE MACRO make_dup_id(location_id, sample_date, depth, fraction, meas_basis) AS (
    CONCAT_WS('_',
        location_id,
        CAST(sample_date AS VARCHAR),
        COALESCE(CAST(depth AS VARCHAR), 'NS'),
        COALESCE(fraction, 'unspecified'),
        COALESCE(meas_basis, 'unspecified')
    )
);

-- Relative Percent Difference between two results (standard QA/QC metric)
CREATE OR REPLACE MACRO rpd(result1, result2) AS (
    ABS(result1 - result2) / NULLIF((result1 + result2) / 2.0, 0) * 100
);

-- Format result for display with appropriate precision
CREATE OR REPLACE MACRO format_result(result, sig_figs) AS (
    CASE
        WHEN result IS NULL THEN NULL
        WHEN result = 0 THEN '0'
        WHEN ABS(result) >= 1 THEN CAST(ROUND(result, sig_figs - 1 - CAST(FLOOR(LOG10(GREATEST(ABS(result), 1e-300))) AS INTEGER)) AS VARCHAR)
        ELSE CAST(ROUND(result, sig_figs) AS VARCHAR)
    END
);

CREATE OR REPLACE MACRO bin_equal_interval(value_list, n_classes) AS (
    CASE
        WHEN n_classes IS NULL OR n_classes <= 0 THEN CAST([] AS DOUBLE[])
        ELSE (
            WITH params AS (
                SELECT
                    COALESCE(value_list, CAST([] AS DOUBLE[])) AS vals,
                    len(COALESCE(value_list, CAST([] AS DOUBLE[]))) AS n
            ),
            bounds AS (
                SELECT
                    list_min(vals) AS min_val,
                    list_max(vals) AS max_val
                FROM params
            ),
            steps AS (
                SELECT range AS idx
                FROM range(n_classes + 1)
            ),
            cuts AS (
                SELECT
                    min_val + (max_val - min_val) * idx::DOUBLE / n_classes AS boundary
                FROM bounds, steps
            )
            SELECT CASE
                WHEN (SELECT n FROM params) = 0 THEN CAST([] AS DOUBLE[])
                ELSE (SELECT LIST(boundary) FROM cuts)
            END
        )
    END
);

CREATE OR REPLACE MACRO bin_quantile(value_list, n_classes) AS (
    CASE
        WHEN n_classes IS NULL OR n_classes <= 0 THEN CAST([] AS DOUBLE[])
        ELSE (
            WITH params AS (
                SELECT
                    COALESCE(value_list, CAST([] AS DOUBLE[])) AS vals,
                    len(COALESCE(value_list, CAST([] AS DOUBLE[]))) AS n
            ),
            sorted AS (
                SELECT
                    CAST(value AS DOUBLE) AS value,
                    ROW_NUMBER() OVER (ORDER BY value) - 1 AS idx
                FROM params, UNNEST(params.vals) AS t(value)
            ),
            steps AS (
                SELECT range AS step_idx
                FROM range(n_classes + 1)
            ),
            calc AS (
                SELECT
                    step_idx,
                    n_vals,
                    pos,
                    CAST(FLOOR(pos) AS BIGINT) AS floor_idx,
                    CAST(CEIL(pos) AS BIGINT) AS ceil_idx
                FROM (
                    SELECT
                        s.step_idx,
                        p.n AS n_vals,
                        CASE
                            WHEN p.n <= 1 THEN 0.0
                            ELSE s.step_idx::DOUBLE * (p.n - 1)::DOUBLE / n_classes
                        END AS pos
                    FROM steps s
                    CROSS JOIN params p
                ) sub
            ),
            interp AS (
                SELECT
                    c.step_idx,
                    CASE
                        WHEN c.n_vals = 0 THEN NULL
                        WHEN sf.value IS NULL THEN NULL
                        WHEN c.floor_idx = c.ceil_idx THEN sf.value
                        ELSE sf.value + (c.pos - CAST(c.floor_idx AS DOUBLE)) * (sc.value - sf.value)
                    END AS boundary
                FROM calc c
                LEFT JOIN sorted sf ON sf.idx = c.floor_idx
                LEFT JOIN sorted sc ON sc.idx = c.ceil_idx
                WHERE c.n_vals > 0
            )
            SELECT COALESCE(
                (
                    SELECT array_agg(boundary ORDER BY step_idx)
                    FROM interp
                ),
                CAST([] AS DOUBLE[])
            )
        )
    END
);

CREATE OR REPLACE MACRO mann_kendall_trend(date_list, value_list) AS TABLE
WITH params AS (
        SELECT
            COALESCE(value_list, CAST([] AS DOUBLE[])) AS vals,
            COALESCE(date_list, CAST([] AS DATE[])) AS dates,
            len(COALESCE(value_list, CAST([] AS DOUBLE[]))) AS n_vals,
            len(COALESCE(date_list, CAST([] AS DATE[]))) AS n_dates
    ),
    prepared AS (
        SELECT
            vals,
            dates,
            LEAST(n_vals, n_dates) AS n_effective,
            CASE WHEN n_vals = n_dates THEN TRUE ELSE FALSE END AS lengths_match
        FROM params
    ),
    idx AS (
        SELECT range AS pos
        FROM prepared, range(prepared.n_effective)
    ),
    data AS (
        SELECT
            list_extract(dates, pos + 1) AS sample_date,
            list_extract(vals, pos + 1) AS sample_value,
            pos
        FROM prepared
        CROSS JOIN idx
    ),
    pairs AS (
        SELECT
            CASE
                WHEN d2.sample_value > d1.sample_value THEN 1
                WHEN d2.sample_value < d1.sample_value THEN -1
                ELSE 0
            END AS sign_val
        FROM data d1
        JOIN data d2 ON d2.pos > d1.pos
    ),
    s_calc AS (
        SELECT COALESCE(SUM(sign_val), 0) AS s
        FROM pairs
    ),
    var_calc AS (
        SELECT
            CASE
                WHEN n_effective <= 1 THEN 0.0
                ELSE n_effective * (n_effective - 1) * (2 * n_effective + 5) / 18.0
            END AS var_s,
            n_effective,
            lengths_match
        FROM prepared
    ),
    stats AS (
        SELECT
            s_calc.s,
            var_calc.var_s,
            var_calc.n_effective,
            var_calc.lengths_match,
            CASE
                WHEN var_calc.var_s = 0 THEN 0.0
                WHEN s_calc.s > 0 THEN (s_calc.s - 1) / SQRT(var_calc.var_s)
                WHEN s_calc.s < 0 THEN (s_calc.s + 1) / SQRT(var_calc.var_s)
                ELSE 0.0
            END AS z_score
        FROM s_calc CROSS JOIN var_calc
    ),
    results AS (
        SELECT
            s,
            z_score,
            var_s,
            n_effective,
            lengths_match,
            CASE
                WHEN var_s = 0 THEN 1.0
                ELSE 2 * (1 - normal_cdf(ABS(z_score)))
            END AS p_value
        FROM stats
    )
    SELECT
        s AS s_statistic,
        z_score,
        CASE
            WHEN NOT lengths_match OR n_effective <= 1 THEN 1.0
            ELSE p_value
        END AS p_value,
        CASE
            WHEN NOT lengths_match OR n_effective <= 1 THEN 'insufficient_data'
            WHEN p_value < 0.05 AND s > 0 THEN 'increasing'
            WHEN p_value < 0.05 AND s < 0 THEN 'decreasing'
            ELSE 'no_trend'
        END AS trend
    FROM results;

CREATE OR REPLACE MACRO sen_slope(date_list, value_list) AS (
    WITH params AS (
        SELECT
            COALESCE(value_list, CAST([] AS DOUBLE[])) AS vals,
            COALESCE(date_list, CAST([] AS DATE[])) AS dates,
            len(COALESCE(value_list, CAST([] AS DOUBLE[]))) AS n_vals,
            len(COALESCE(date_list, CAST([] AS DATE[]))) AS n_dates
    ),
    prepared AS (
        SELECT
            vals,
            dates,
            LEAST(n_vals, n_dates) AS n_effective,
            CASE WHEN n_vals = n_dates THEN TRUE ELSE FALSE END AS lengths_match
        FROM params
    ),
    idx AS (
        SELECT range AS pos
        FROM prepared, range(prepared.n_effective)
    ),
    data AS (
        SELECT
            list_extract(dates, pos + 1) AS sample_date,
            list_extract(vals, pos + 1) AS sample_value,
            pos
        FROM prepared
        CROSS JOIN idx
    ),
    slopes AS (
        SELECT
            (d2.sample_value - d1.sample_value) /
            NULLIF(CAST(date_diff('day', d1.sample_date, d2.sample_date) AS DOUBLE), 0.0) AS slope
        FROM data d1
        JOIN data d2 ON d2.pos > d1.pos
        WHERE date_diff('day', d1.sample_date, d2.sample_date) <> 0
    ),
    slope_stats AS (
        SELECT
            CASE
                WHEN COUNT(*) = 0 THEN NULL
                ELSE PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY slope)
            END AS median_slope
        FROM slopes
    )
    SELECT CASE
        WHEN NOT lengths_match OR n_effective <= 1 THEN NULL
        ELSE (SELECT median_slope FROM slope_stats)
    END
    FROM prepared
);

CREATE OR REPLACE MACRO pivot_results_by_analyte(
    analyte_list,
    matrix_filter,
    location_list,
    start_date,
    end_date,
    nd_method,
    nd_fixed,
    nd_multiplier
) AS TABLE
WITH params AS (
        SELECT
            CAST(analyte_list AS VARCHAR[]) AS analytes,
            CAST(location_list AS VARCHAR[]) AS locations,
            CASE WHEN analyte_list IS NOT NULL THEN TRUE ELSE FALSE END AS has_analytes,
            CASE WHEN location_list IS NOT NULL THEN TRUE ELSE FALSE END AS has_locations,
            COALESCE(nd_method, 'raw') AS nd_method,
            COALESCE(nd_fixed, 0.0) AS nd_fixed,
            COALESCE(nd_multiplier, 1.0) AS nd_multiplier
    ),
    analyte_filter AS (
        SELECT value AS analyte
        FROM params, UNNEST(COALESCE(analytes, CAST([] AS VARCHAR[]))) AS t(value)
    ),
    location_filter AS (
        SELECT value AS location_id
        FROM params, UNNEST(COALESCE(locations, CAST([] AS VARCHAR[]))) AS t(value)
    ),
    filtered AS (
        SELECT r.*, p.nd_method, p.nd_fixed, p.nd_multiplier, p.has_analytes, p.has_locations
        FROM v_results_denormalized r
        CROSS JOIN params p
        WHERE
            (matrix_filter IS NULL OR r.matrix = matrix_filter)
            AND (start_date IS NULL OR r.sample_date >= start_date)
            AND (end_date IS NULL OR r.sample_date <= end_date)
            AND (
                NOT p.has_analytes
                OR r.analyte IN (SELECT analyte FROM analyte_filter)
            )
            AND (
                NOT p.has_locations
                OR r.location_id IN (SELECT location_id FROM location_filter)
            )
    ),
    nd_adjusted AS (
        SELECT
            *,
            nd_adjusted_result(
                result,
                detected,
                detection_limit,
                nd_method,
                nd_fixed,
                nd_multiplier
            ) AS adj_result
        FROM filtered
    ),
    aggregated AS (
        SELECT
            location_id,
            x,
            y,
            geom,
            matrix,
            analyte,
            AVG(adj_result) AS avg_result,
            COUNT(*) AS sample_count,
            MIN(sample_date) AS first_sample_date,
            MAX(sample_date) AS last_sample_date
        FROM nd_adjusted
        GROUP BY
            location_id,
            x,
            y,
            geom,
            matrix,
            analyte
    )
    SELECT *
    FROM aggregated;

-- ============================================================================
-- Analyte Pair Data - Cross-tab for chemical-by-chemical scatter plots
-- ============================================================================
-- Pairs two analytes by location and sample date, averaging duplicate
-- measurements. Returns one row per location/sample_date where BOTH
-- analytes have data (inner join). Used for scatter/correlation plots.

CREATE OR REPLACE MACRO analyte_pair_data(
    analyte_a,
    analyte_b,
    matrix_filter,
    location_list,
    start_date,
    end_date
) AS TABLE
WITH params AS (
        SELECT
            CAST(location_list AS VARCHAR[]) AS locations,
            CASE WHEN location_list IS NOT NULL THEN TRUE ELSE FALSE END AS has_locations
    ),
    location_filter AS (
        SELECT value AS location_id
        FROM params, UNNEST(COALESCE(locations, CAST([] AS VARCHAR[]))) AS t(value)
    ),
    base AS (
        SELECT r.*
        FROM v_results_denormalized r
        CROSS JOIN params p
        WHERE
            r.analyte IN (analyte_a, analyte_b)
            AND (matrix_filter IS NULL OR r.matrix = matrix_filter)
            AND (start_date IS NULL OR r.sample_date >= start_date)
            AND (end_date IS NULL OR r.sample_date <= end_date)
            AND (
                NOT p.has_locations
                OR r.location_id IN (SELECT location_id FROM location_filter)
            )
    ),
    side_a AS (
        SELECT
            location_id, x, y, geom, sample_date, matrix,
            AVG(result) AS result_a
        FROM base
        WHERE analyte = analyte_a
        GROUP BY location_id, x, y, geom, sample_date, matrix
    ),
    side_b AS (
        SELECT
            location_id, sample_date,
            AVG(result) AS result_b
        FROM base
        WHERE analyte = analyte_b
        GROUP BY location_id, sample_date
    )
    SELECT
        a.location_id,
        a.x,
        a.y,
        a.geom,
        a.sample_date,
        a.matrix,
        a.result_a,
        b.result_b
    FROM side_a a
    INNER JOIN side_b b
        ON a.location_id = b.location_id
        AND a.sample_date = b.sample_date;

-- ============================================================================
-- Analyte Composition - Relative percentage of each analyte per location
-- ============================================================================
-- Computes per-location analyte composition as percentage of total
-- concentration. Used for chemical fingerprinting / forensics stacked
-- bar charts. Accepts an analyte list to control which analytes are
-- included in the composition calculation.

CREATE OR REPLACE MACRO analyte_composition(
    analyte_list,
    matrix_filter,
    location_list,
    start_date,
    end_date
) AS TABLE
WITH params AS (
        SELECT
            CAST(analyte_list AS VARCHAR[]) AS analytes,
            CAST(location_list AS VARCHAR[]) AS locations,
            CASE WHEN analyte_list IS NOT NULL THEN TRUE ELSE FALSE END AS has_analytes,
            CASE WHEN location_list IS NOT NULL THEN TRUE ELSE FALSE END AS has_locations
    ),
    analyte_filter AS (
        SELECT value AS analyte
        FROM params, UNNEST(COALESCE(analytes, CAST([] AS VARCHAR[]))) AS t(value)
    ),
    location_filter AS (
        SELECT value AS location_id
        FROM params, UNNEST(COALESCE(locations, CAST([] AS VARCHAR[]))) AS t(value)
    ),
    filtered AS (
        SELECT r.*
        FROM v_results_denormalized r
        CROSS JOIN params p
        WHERE
            (matrix_filter IS NULL OR r.matrix = matrix_filter)
            AND (start_date IS NULL OR r.sample_date >= start_date)
            AND (end_date IS NULL OR r.sample_date <= end_date)
            AND (
                NOT p.has_analytes
                OR r.analyte IN (SELECT analyte FROM analyte_filter)
            )
            AND (
                NOT p.has_locations
                OR r.location_id IN (SELECT location_id FROM location_filter)
            )
    ),
    per_analyte AS (
        SELECT
            location_id,
            x,
            y,
            geom,
            matrix,
            analyte,
            SUM(result) AS total_concentration,
            COUNT(*) AS sample_count
        FROM filtered
        GROUP BY location_id, x, y, geom, matrix, analyte
    ),
    per_location AS (
        SELECT
            location_id,
            SUM(total_concentration) AS location_total
        FROM per_analyte
        GROUP BY location_id
    )
    SELECT
        pa.location_id,
        pa.x,
        pa.y,
        pa.geom,
        pa.matrix,
        pa.analyte,
        pa.total_concentration,
        pa.sample_count,
        pl.location_total,
        CASE
            WHEN pl.location_total = 0 THEN 0.0
            ELSE ROUND(100.0 * pa.total_concentration / pl.location_total, 2)
        END AS pct_of_total
    FROM per_analyte pa
    JOIN per_location pl ON pa.location_id = pl.location_id;

-- ============================================================================
-- Classify Concentration - Quantile binning with ND separation
-- ============================================================================
-- Assigns each result record to a quantile-based concentration bin.
-- Non-detects are placed in a separate 'ND' bin. Detected values are
-- divided into n_classes bins using NTILE (equal-count partitioning).
-- Returns per-record bin assignment with human-readable range labels.
-- Used for choropleth map symbology.

CREATE OR REPLACE MACRO classify_concentration(
    analyte_filter,
    matrix_filter,
    location_list,
    start_date,
    end_date,
    n_classes
) AS TABLE
WITH params AS (
        SELECT
            CAST(location_list AS VARCHAR[]) AS locations,
            CASE WHEN location_list IS NOT NULL THEN TRUE ELSE FALSE END AS has_locations
    ),
    location_filter AS (
        SELECT value AS location_id
        FROM params, UNNEST(COALESCE(locations, CAST([] AS VARCHAR[]))) AS t(value)
    ),
    filtered AS (
        SELECT r.*
        FROM v_results_denormalized r
        CROSS JOIN params p
        WHERE
            r.analyte = analyte_filter
            AND (matrix_filter IS NULL OR r.matrix = matrix_filter)
            AND (start_date IS NULL OR r.sample_date >= start_date)
            AND (end_date IS NULL OR r.sample_date <= end_date)
            AND (
                NOT p.has_locations
                OR r.location_id IN (SELECT location_id FROM location_filter)
            )
    ),
    detect_binned AS (
        SELECT
            f.location_id, f.x, f.y, f.geom,
            f.sample_date, f.matrix, f.analyte, f.result,
            f.detected, f.detection_limit, f.qualifier, f.std_units,
            NTILE(COALESCE(n_classes, 4)) OVER (ORDER BY f.result) AS bin_num
        FROM filtered f
        WHERE f.detected
    ),
    nd_records AS (
        SELECT
            f.location_id, f.x, f.y, f.geom,
            f.sample_date, f.matrix, f.analyte, f.result,
            f.detected, f.detection_limit, f.qualifier, f.std_units,
            0 AS bin_num
        FROM filtered f
        WHERE NOT f.detected
    ),
    all_binned AS (
        SELECT * FROM detect_binned
        UNION ALL
        SELECT * FROM nd_records
    ),
    bin_stats AS (
        SELECT
            bin_num,
            MIN(result) AS bin_min,
            MAX(result) AS bin_max,
            COUNT(*) AS bin_count
        FROM all_binned
        GROUP BY bin_num
    )
    SELECT
        ab.location_id,
        ab.x,
        ab.y,
        ab.geom,
        ab.sample_date,
        ab.matrix,
        ab.analyte,
        ab.result,
        ab.detected,
        ab.detection_limit,
        ab.qualifier,
        ab.std_units,
        CASE WHEN ab.bin_num = 0 THEN 'ND'
             ELSE CAST(ab.bin_num AS VARCHAR)
        END AS concentration_bin,
        CASE WHEN ab.bin_num = 0 THEN 'ND'
             ELSE CAST(ROUND(bs.bin_min, 4) AS VARCHAR)
                  || ' - '
                  || CAST(ROUND(bs.bin_max, 4) AS VARCHAR)
        END AS bin_label,
        bs.bin_count
    FROM all_binned ab
    LEFT JOIN bin_stats bs ON ab.bin_num = bs.bin_num;
