-- ChemDuck Schema: High-level result aggregation macro
-- Phase 8.1: The single entry point consumer apps call to get pre-aggregated
-- results for an analyte+filter+aggregation configuration.
--
-- This file is ordered AFTER 03_views.sql because the macro references
-- v_results_denormalized in its body. DuckDB validates table references at
-- macro definition time, so the view must exist first.

-- ============================================================================
-- 8.1 aggregate_results - Canonical two-stage aggregation pipeline
-- ============================================================================
--
-- Two-stage collapse:
--   1. dup collapse   - within a single (location, sample_date, depth interval,
--                       fraction, meas_basis) key, reduce duplicate
--                       measurements to one value using `dup_agg`
--   2. event collapse - across multiple events at a single (location, matrix,
--                       top_depth, bottom_depth) key, reduce events to one
--                       representative row using `event_agg`
--
-- Non-detects are handled ND-aware throughout:
--   - nd_method 'raw'     uses the reported value
--   - nd_method 'half_dl' substitutes 0.5 * detection_limit
--   - nd_method 'dl'      substitutes detection_limit
--   - nd_method 'zero'    substitutes 0
--   - nd_method 'exclude' drops ND rows entirely before aggregation
--
-- event_agg = 'most_recent'
--   Sort events DESC by sample_date (then result_id tiebreak). Winner's
--   detected flag is preserved verbatim. Useful for "current status" maps.
--
-- event_agg = 'maximum'
--   If any events are detects, the winner is the detected row with the
--   highest adjusted result. If ALL events are non-detects, the winner is
--   the ND row with the highest detection_limit (most conservative ND).
--   Matches environmental viz conventions.
--
-- event_agg = 'mean'
--   Arithmetic mean of adjusted results. The output detected flag is true
--   if any contributing event was a detect. Representative date is the
--   most recent contributing date; also exposes first_sample_date and
--   last_sample_date.
--
-- Partition key for event aggregation is always
--   (location_id, matrix, top_depth, bottom_depth)
-- because in environmental contexts distinct depth intervals are distinct
-- physical measurement points even when they share x/y coordinates. The
-- partition never collapses across depth.
--
-- Parameters:
--   p_analyte        VARCHAR   - required analyte filter (exact match)
--   p_matrix         VARCHAR   - optional matrix filter (NULL = all matrices)
--   p_start_date     DATE      - optional inclusive lower bound on sample_date
--   p_end_date       DATE      - optional inclusive upper bound on sample_date
--   p_event_agg      VARCHAR   - 'most_recent' | 'maximum' | 'mean'
--   p_dup_agg        VARCHAR   - 'avg' | 'max' | 'min' | 'first' | 'last'
--   p_nd_method      VARCHAR   - 'raw' | 'half_dl' | 'dl' | 'zero' | 'exclude'
--   p_nd_fixed       DOUBLE    - value used when nd_method is 'fixed' (reserved)
--   p_nd_multiplier  DOUBLE    - multiplier for 'multiplier' ND method (reserved)
--
-- Returned columns:
--   location_id, x, y, geom, matrix
--   top_depth, bottom_depth, depth
--   analyte, anl_sm_mb, analyte_group, cas_number
--   result                - the aggregated value (post ND-adjustment)
--   detected              - whether the aggregated value reflects a detect
--   units, std_units      - representative units strings
--   rep_sample_date       - representative date (winning date or last date)
--   first_sample_date     - earliest contributing event date
--   last_sample_date      - latest contributing event date
--   n_events              - count of events contributing
--   n_detects             - count of detected events
--   detection_limit       - representative DL (winner's, or max across events)

CREATE OR REPLACE MACRO aggregate_results(
    p_analyte,
    p_matrix,
    p_start_date,
    p_end_date,
    p_event_agg,
    p_dup_agg,
    p_nd_method,
    p_nd_fixed,
    p_nd_multiplier
) AS TABLE
WITH filtered AS (
    SELECT
        v.location_id,
        v.x, v.y, v.geom,
        v.matrix,
        -- NULL depths collapse to (0, 0) so a location's surface samples
        -- and "no depth recorded" samples land in the same partition.
        -- Distinct non-null depth intervals remain distinct partitions.
        COALESCE(v.top_depth, 0)    AS top_depth,
        COALESCE(v.bottom_depth, 0) AS bottom_depth,
        COALESCE(v.depth, 0)        AS depth,
        v.sample_date,
        v.sample_id,
        v.fraction,
        v.meas_basis,
        v.analyte,
        v.anl_sm_mb,
        v.analyte_group,
        v.cas_number,
        v.result,
        v.detected,
        v.estimated,
        v.detection_limit,
        v.units,
        v.std_units,
        v.result_id
    FROM v_results_denormalized v
    WHERE v.analyte = p_analyte
      AND (p_matrix IS NULL OR v.matrix = p_matrix)
      AND (p_start_date IS NULL OR v.sample_date >= p_start_date)
      AND (p_end_date IS NULL OR v.sample_date <= p_end_date)
      -- Drop NDs entirely when nd_method is 'exclude'
      AND NOT (p_nd_method = 'exclude' AND NOT v.detected)
),
-- Stage 0: substitute ND values so downstream aggregation works on adjusted
-- values. Preserve the raw detected flag so the caller can still tell.
adjusted AS (
    SELECT
        *,
        nd_adjusted_result(
            result, detected, detection_limit,
            p_nd_method, p_nd_fixed, p_nd_multiplier
        ) AS adj_result
    FROM filtered
),
-- Stage 1: dup collapse.
-- Collapse duplicate measurements at the same (location, date, depth,
-- fraction, meas_basis) key via the selected duplicate_aggregate method.
-- The dup_agg operates on adjusted values (not raw), consistent with the
-- convention that ND substitution happens first.
dup_collapsed AS (
    SELECT
        location_id,
        any_value(x) AS x,
        any_value(y) AS y,
        any_value(geom) AS geom,
        matrix,
        top_depth,
        bottom_depth,
        any_value(depth) AS depth,
        sample_date,
        fraction,
        meas_basis,
        analyte,
        any_value(anl_sm_mb) AS anl_sm_mb,
        any_value(analyte_group) AS analyte_group,
        any_value(cas_number) AS cas_number,
        any_value(units) AS units,
        any_value(std_units) AS std_units,
        -- Adjusted value aggregated according to p_dup_agg
        CASE p_dup_agg
            WHEN 'avg'   THEN avg(adj_result)
            WHEN 'max'   THEN max(adj_result)
            WHEN 'min'   THEN min(adj_result)
            WHEN 'first' THEN first(adj_result ORDER BY result_id)
            WHEN 'last'  THEN last(adj_result ORDER BY result_id)
            ELSE avg(adj_result)
        END AS adj_result,
        -- A group is "detected" if any contributing row was a detect
        bool_or(detected) AS detected,
        -- Conservative DL: the max across the dup group
        max(detection_limit) AS detection_limit,
        min(result_id) AS min_result_id
    FROM adjusted
    GROUP BY
        location_id, matrix,
        top_depth, bottom_depth,
        sample_date, fraction, meas_basis,
        analyte
),
-- Stage 2: event collapse.
-- Collapse multiple events at a single (location, matrix, top_depth,
-- bottom_depth) key into one representative row using the selected event_agg.
--
-- Implementation note: DuckDB table macros can only contain one SELECT, so
-- we compute ALL three strategies in parallel via CTEs that each filter on
-- p_event_agg. Only one CTE's UNION ALL branch returns rows for any given
-- call — the others are empty.
most_recent_winners AS (
    SELECT
        location_id, x, y, geom, matrix,
        top_depth, bottom_depth, depth,
        sample_date AS rep_sample_date,
        analyte, anl_sm_mb, analyte_group, cas_number,
        units, std_units,
        adj_result AS result,
        detected,
        detection_limit,
        -- Aggregate stats require a window over the full partition
        count(*) OVER (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS n_events,
        sum(CASE WHEN detected THEN 1 ELSE 0 END) OVER
            (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS n_detects,
        min(sample_date) OVER
            (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS first_sample_date,
        max(sample_date) OVER
            (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS last_sample_date
    FROM dup_collapsed
    WHERE p_event_agg = 'most_recent'
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY location_id, matrix, top_depth, bottom_depth
        ORDER BY sample_date DESC, min_result_id DESC
    ) = 1
),
maximum_winners AS (
    SELECT
        location_id, x, y, geom, matrix,
        top_depth, bottom_depth, depth,
        sample_date AS rep_sample_date,
        analyte, anl_sm_mb, analyte_group, cas_number,
        units, std_units,
        adj_result AS result,
        detected,
        detection_limit,
        count(*) OVER (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS n_events,
        sum(CASE WHEN detected THEN 1 ELSE 0 END) OVER
            (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS n_detects,
        min(sample_date) OVER
            (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS first_sample_date,
        max(sample_date) OVER
            (PARTITION BY location_id, matrix, top_depth, bottom_depth)
            AS last_sample_date
    FROM dup_collapsed
    WHERE p_event_agg = 'maximum'
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY location_id, matrix, top_depth, bottom_depth
        ORDER BY
            -- Rank 0 if detected, rank 1 if not → detects always win when present
            CASE WHEN detected THEN 0 ELSE 1 END,
            -- Among detects: highest adj_result first.
            -- Among NDs: highest detection_limit first (most conservative).
            CASE WHEN detected THEN adj_result ELSE detection_limit END DESC,
            sample_date DESC,
            min_result_id DESC
    ) = 1
),
mean_winners AS (
    SELECT
        location_id,
        any_value(x) AS x,
        any_value(y) AS y,
        any_value(geom) AS geom,
        matrix,
        top_depth,
        bottom_depth,
        any_value(depth) AS depth,
        max(sample_date) AS rep_sample_date,
        analyte,
        any_value(anl_sm_mb) AS anl_sm_mb,
        any_value(analyte_group) AS analyte_group,
        any_value(cas_number) AS cas_number,
        any_value(units) AS units,
        any_value(std_units) AS std_units,
        avg(adj_result) AS result,
        bool_or(detected) AS detected,
        max(detection_limit) AS detection_limit,
        count(*) AS n_events,
        sum(CASE WHEN detected THEN 1 ELSE 0 END) AS n_detects,
        min(sample_date) AS first_sample_date,
        max(sample_date) AS last_sample_date
    FROM dup_collapsed
    WHERE p_event_agg = 'mean'
    GROUP BY
        location_id, matrix,
        top_depth, bottom_depth,
        analyte
)
SELECT * FROM most_recent_winners
UNION ALL
SELECT * FROM maximum_winners
UNION ALL
SELECT * FROM mean_winners;
