-- ChemDuck Schema: Analytical Views
-- Phase 2.1-2.5: Read layer for client queries

-- ============================================================================
-- 2.1 v_results_denormalized - Wide view joining all base tables
-- ============================================================================
-- This is the primary view for most analytical queries
-- Excludes QA/QC sample types and rejected records by default

CREATE OR REPLACE VIEW v_results_denormalized AS
SELECT
    -- Location fields
    l.location_id,
    l.x,
    l.y,
    l.geom,
    l.loc_type,
    l.loc_desc,
    l.aquifer,
    l.region,
    l.dataset,
    l.project,
    l.study,

    -- Sample fields
    s.sample_id,
    s.sample_date,
    s.matrix,
    s.top_depth,
    s.bottom_depth,
    s.depth,
    s.depth_units,
    s.sample_type,
    s.composite_type,
    s.event,

    -- Result fields
    r.result_id,
    r.analyte,
    r.anl_sm_mb,
    r.analyte_group,
    r.cas_number,
    r.result,
    r.units,
    r.std_units,
    r.method_detection_limit,
    r.reporting_limit,
    r.quantitation_limit,
    r.upper_quantitation_limit,
    r.dilution_factor,
    r.modeled_relative_uncertainty,
    r.detected,
    r.estimated,
    r.tic,
    r.qualifier,
    r.lab_name,
    r.lab_sample_id,
    r.method_code,
    r.meas_basis,
    r.fraction,

    -- Computed fields
    COALESCE(r.reporting_limit, r.method_detection_limit, r.quantitation_limit) AS detection_limit,
    moist.moisture_result AS percent_moisture,
    make_dup_id(l.location_id, s.sample_date, s.depth, r.fraction, r.meas_basis) AS dup_id,
    dv_qualifier(r.detected, r.estimated) AS dv_qual,
    EXTRACT(YEAR FROM s.sample_date) AS sample_year,
    STRFTIME(s.sample_date, '%Y-%m') AS sample_month

FROM results r
JOIN samples s ON r.sample_id = s.sample_id
JOIN locations l ON s.location_id = l.location_id
LEFT JOIN (
    SELECT
        r_m.sample_id,
        r_m.lab_sample_id,
        r_m.result AS moisture_result
    FROM results r_m
    WHERE UPPER(r_m.analyte) IN (
        'PERCENT MOISTURE', '% MOISTURE', 'MOISTURE',
        'PERCENT_MOISTURE', 'MOISTURE CONTENT', '% MOISTURE CONTENT'
    )
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY COALESCE(r_m.lab_sample_id, r_m.sample_id)
        ORDER BY r_m.result_id
    ) = 1
) moist ON COALESCE(r.lab_sample_id, r.sample_id) = COALESCE(moist.lab_sample_id, moist.sample_id)
WHERE
    -- Exclude QA/QC and special sample types
    (s.sample_type IS NULL OR s.sample_type NOT IN ('AVG', 'REAN', 'DNU', 'IDW', 'NR'))
    -- Exclude rejected records (qualifier ending in R)
    AND (r.qualifier IS NULL OR r.qualifier NOT LIKE '%R');

-- ============================================================================
-- 2.2 v_results_for_mapping - Pre-aggregated for spatial display
-- ============================================================================
-- Aggregates results by location/analyte for quick mapping queries

CREATE OR REPLACE VIEW v_results_for_mapping AS
SELECT
    location_id,
    x,
    y,
    geom,
    matrix,
    analyte,
    anl_sm_mb,
    analyte_group,
    units,
    std_units,
    MIN(sample_date) AS min_date,
    MAX(sample_date) AS max_date,
    COUNT(*) AS sample_count,
    AVG(result) AS avg_result,
    MIN(result) AS min_result,
    MAX(result) AS max_result,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY result) AS median_result,
    STDDEV(result) AS std_result,
    SUM(CASE WHEN detected THEN 1 ELSE 0 END) AS detect_count,
    SUM(CASE WHEN NOT detected THEN 1 ELSE 0 END) AS nondetect_count,
    COUNT(DISTINCT sample_date) AS n_events
FROM v_results_denormalized
GROUP BY
    location_id, x, y, geom,
    matrix, analyte, anl_sm_mb, analyte_group,
    units, std_units;

-- ============================================================================
-- 2.3 v_most_recent_results - Latest sample per location/analyte
-- ============================================================================
-- Returns only the most recent measurement for each location/analyte/matrix
-- Uses DuckDB's QUALIFY clause for efficient window function filtering

CREATE OR REPLACE VIEW v_most_recent_results AS
SELECT *
FROM v_results_denormalized
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY location_id, analyte, matrix
    ORDER BY sample_date DESC, result_id DESC
) = 1;

-- ============================================================================
-- 2.4 v_results_with_screening - Results joined with screening levels
-- ============================================================================
-- Pre-joins results with applicable screening levels for exceedance analysis
-- Uses LEFT JOIN so results without screening levels are still included

CREATE OR REPLACE VIEW v_results_with_screening AS
SELECT
    r.*,
    sl.screening_id,
    sl.name AS screening_name,
    sl.level_type,
    sl.value AS screening_value,
    sl.comparison AS screening_comparison,
    sl.source AS screening_source,
    CASE
        WHEN sl.value IS NULL THEN NULL
        WHEN sl.comparison = '<' AND r.result < sl.value THEN 'EXCEEDS'
        WHEN sl.comparison = '<' AND r.result < sl.value * 1.2 THEN 'APPROACHING'
        WHEN sl.comparison = '<' THEN 'ABOVE'
        WHEN r.result > sl.value THEN 'EXCEEDS'
        WHEN r.result > sl.value * 0.8 THEN 'APPROACHING'
        ELSE 'BELOW'
    END AS exceedance_status,
    CASE
        WHEN sl.value IS NULL OR sl.value = 0 THEN NULL
        WHEN sl.comparison = '<' THEN sl.value / r.result
        ELSE r.result / sl.value
    END AS exceedance_ratio
FROM v_results_denormalized r
LEFT JOIN screening_levels sl
    ON r.analyte = sl.analyte
    AND r.matrix = sl.matrix
    AND r.std_units = sl.units;

-- ============================================================================
-- 2.5 v_exceedances - Filtered view of results that exceed screening levels
-- ============================================================================
-- Convenience view showing only records that exceed their screening level

CREATE OR REPLACE VIEW v_exceedances AS
SELECT *
FROM v_results_with_screening
WHERE exceedance_status = 'EXCEEDS';

-- ============================================================================
-- Additional utility views
-- ============================================================================

-- v_analyte_summary - Summary statistics by analyte/matrix
CREATE OR REPLACE VIEW v_analyte_summary AS
SELECT
    analyte,
    matrix,
    std_units,
    COUNT(*) AS n_results,
    COUNT(DISTINCT location_id) AS n_locations,
    COUNT(DISTINCT sample_date) AS n_dates,
    SUM(CASE WHEN detected THEN 1 ELSE 0 END) AS n_detect,
    SUM(CASE WHEN NOT detected THEN 1 ELSE 0 END) AS n_nondetect,
    ROUND(100.0 * SUM(CASE WHEN detected THEN 1 ELSE 0 END) / COUNT(*), 1) AS detect_pct,
    MIN(result) AS min_result,
    MAX(result) AS max_result,
    AVG(result) AS mean_result,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY result) AS median_result
FROM v_results_denormalized
GROUP BY analyte, matrix, std_units;

-- v_location_summary - Summary by location
CREATE OR REPLACE VIEW v_location_summary AS
SELECT
    location_id,
    x,
    y,
    geom,
    matrix,
    COUNT(DISTINCT analyte) AS n_analytes,
    COUNT(*) AS n_results,
    MIN(sample_date) AS first_sample,
    MAX(sample_date) AS last_sample,
    COUNT(DISTINCT sample_date) AS n_events
FROM v_results_denormalized
GROUP BY location_id, x, y, geom, matrix;

-- v_available_filters - Distinct values for UI filter population
CREATE OR REPLACE VIEW v_available_filters AS
SELECT
    'matrix' AS filter_type,
    matrix AS filter_value,
    COUNT(*) AS n_records
FROM v_results_denormalized
GROUP BY matrix
UNION ALL
SELECT
    'analyte_group' AS filter_type,
    analyte_group AS filter_value,
    COUNT(*) AS n_records
FROM v_results_denormalized
WHERE analyte_group IS NOT NULL
GROUP BY analyte_group
UNION ALL
SELECT
    'lab_name' AS filter_type,
    lab_name AS filter_value,
    COUNT(*) AS n_records
FROM v_results_denormalized
WHERE lab_name IS NOT NULL
GROUP BY lab_name
UNION ALL
SELECT
    'event' AS filter_type,
    event AS filter_value,
    COUNT(*) AS n_records
FROM v_results_denormalized
WHERE event IS NOT NULL
GROUP BY event;
