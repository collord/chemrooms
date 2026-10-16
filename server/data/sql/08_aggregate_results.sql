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
-- Measurement identity: every stage partitions on
--   (location_id, matrix, top_depth, bottom_depth, fraction, meas_basis, analyte)
-- Dissolved and total (and dry- and wet-weight) results are different
-- measurements of the same water or soil and are never combined: one call
-- returns one row per fraction/basis present. NULL fraction is its own value.
--
-- Two-stage collapse:
--   1. dup collapse   - within one identity on one sample_date, reduce
--                       duplicate measurements to one value using `dup_agg`
--   2. event collapse - across sample dates within one identity, reduce
--                       events to one representative row using `event_agg`
--
-- Non-detects are handled ND-aware throughout:
--   - nd_method 'raw'     uses the reported value
--   - nd_method 'half_dl' substitutes 0.5 * detection_limit
--   - nd_method 'dl'      substitutes detection_limit
--   - nd_method 'zero'    substitutes 0
--   - nd_method 'exclude' drops ND rows entirely before aggregation
--
-- event_agg = 'most_recent'
--   The event with the latest sample_date. Winner's detected flag is
--   preserved verbatim. Useful for "current status" maps.
--
-- event_agg = 'maximum'
--   If any events are detects, the winner is the detected row with the
--   highest adjusted result. If ALL events are non-detects, the winner is
--   the ND row with the highest detection_limit (most conservative ND).
--   Equal values are broken by the later sample_date.
--
-- event_agg = 'mean'
--   Arithmetic mean of adjusted results. The output detected flag is true
--   if any contributing event was a detect. Representative date is the
--   most recent contributing date; also exposes first_sample_date and
--   last_sample_date.
--
-- Determinism: after the dup collapse each identity has one row per
-- sample_date, so most_recent and maximum have no ties left to break and the
-- answer does not depend on load order. dup_agg 'first'/'last' mean first or
-- last in source-file order (result_id), by definition.
--
-- Units are not converted here. units is the alphabetically first unit in
-- the identity; n_units counts distinct units and units_conflict is TRUE
-- when there is more than one, in which case result mixes units and must not
-- be read as a single concentration. See v_unit_conflicts.
--
-- Partitions never collapse across depth: distinct depth intervals are
-- distinct physical measurement points even when they share x/y.
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
--   p_fraction       VARCHAR   - optional, by name: p_fraction := 'Dissolved'
--                                (NULL = every fraction, each its own row)
--
-- Returned columns:
--   location_id, x, y, geom, matrix
--   top_depth, bottom_depth, depth
--   fraction, meas_basis  - the measurement identity this row describes
--   analyte, anl_sm_mb, analyte_group, cas_number
--   result                - the aggregated value (post ND-adjustment)
--   detected              - whether the aggregated value reflects a detect
--   units, std_units      - representative units strings
--   n_units               - distinct units within the identity
--   units_conflict        - TRUE when n_units > 1 (result mixes units)
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
    p_nd_multiplier,
    p_fraction := NULL
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
      AND (p_fraction IS NULL OR v.fraction = p_fraction)
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
-- Units seen per measurement identity, across all events.
identity_units AS (
    SELECT
        location_id, matrix, top_depth, bottom_depth, fraction, meas_basis, analyte,
        COUNT(DISTINCT units) AS n_units
    FROM filtered
    GROUP BY location_id, matrix, top_depth, bottom_depth, fraction, meas_basis, analyte
),
-- Stage 1: dup collapse.
-- Collapse duplicate measurements within one identity on one sample_date via
-- the selected duplicate_aggregate method. The dup_agg operates on adjusted
-- values (not raw), consistent with ND substitution happening first.
dup_collapsed AS (
    SELECT
        location_id,
        -- x/y/geom come from the locations row, so they are constant here
        any_value(x) AS x,
        any_value(y) AS y,
        any_value(geom) AS geom,
        matrix,
        top_depth,
        bottom_depth,
        min(depth) AS depth,
        sample_date,
        fraction,
        meas_basis,
        analyte,
        min(anl_sm_mb) AS anl_sm_mb,
        min(analyte_group) AS analyte_group,
        min(cas_number) AS cas_number,
        min(units) AS units,
        min(std_units) AS std_units,
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
        max(detection_limit) AS detection_limit
    FROM adjusted
    GROUP BY
        location_id, matrix,
        top_depth, bottom_depth,
        sample_date, fraction, meas_basis,
        analyte
),
-- Stage 2: event collapse.
-- Collapse the events of one measurement identity into one representative
-- row using the selected event_agg.
--
-- Implementation note: DuckDB table macros can only contain one SELECT, so
-- we compute ALL three strategies in parallel via CTEs that each filter on
-- p_event_agg. Only one CTE's UNION ALL branch returns rows for any given
-- call; the others are empty.
most_recent_winners AS (
    SELECT
        location_id, x, y, geom, matrix,
        top_depth, bottom_depth, depth,
        fraction, meas_basis,
        sample_date AS rep_sample_date,
        analyte, anl_sm_mb, analyte_group, cas_number,
        units, std_units,
        adj_result AS result,
        detected,
        detection_limit,
        -- Aggregate stats require a window over the full partition
        count(*) OVER w AS n_events,
        sum(CASE WHEN detected THEN 1 ELSE 0 END) OVER w AS n_detects,
        min(sample_date) OVER w AS first_sample_date,
        max(sample_date) OVER w AS last_sample_date
    FROM dup_collapsed
    WHERE p_event_agg = 'most_recent'
    WINDOW w AS (PARTITION BY location_id, matrix, top_depth, bottom_depth,
                              fraction, meas_basis, analyte)
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY location_id, matrix, top_depth, bottom_depth,
                     fraction, meas_basis, analyte
        ORDER BY sample_date DESC
    ) = 1
),
maximum_winners AS (
    SELECT
        location_id, x, y, geom, matrix,
        top_depth, bottom_depth, depth,
        fraction, meas_basis,
        sample_date AS rep_sample_date,
        analyte, anl_sm_mb, analyte_group, cas_number,
        units, std_units,
        adj_result AS result,
        detected,
        detection_limit,
        count(*) OVER w AS n_events,
        sum(CASE WHEN detected THEN 1 ELSE 0 END) OVER w AS n_detects,
        min(sample_date) OVER w AS first_sample_date,
        max(sample_date) OVER w AS last_sample_date
    FROM dup_collapsed
    WHERE p_event_agg = 'maximum'
    WINDOW w AS (PARTITION BY location_id, matrix, top_depth, bottom_depth,
                              fraction, meas_basis, analyte)
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY location_id, matrix, top_depth, bottom_depth,
                     fraction, meas_basis, analyte
        ORDER BY
            -- Rank 0 if detected, rank 1 if not: detects always win when present
            CASE WHEN detected THEN 0 ELSE 1 END,
            -- Among detects: highest adj_result first.
            -- Among NDs: highest detection_limit first (most conservative).
            CASE WHEN detected THEN adj_result ELSE detection_limit END DESC NULLS LAST,
            -- sample_date is unique within the partition, so this ends ties
            sample_date DESC
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
        min(depth) AS depth,
        fraction,
        meas_basis,
        max(sample_date) AS rep_sample_date,
        analyte,
        min(anl_sm_mb) AS anl_sm_mb,
        min(analyte_group) AS analyte_group,
        min(cas_number) AS cas_number,
        min(units) AS units,
        min(std_units) AS std_units,
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
        fraction, meas_basis,
        analyte
),
winners AS (
    SELECT * FROM most_recent_winners
    UNION ALL BY NAME
    SELECT * FROM maximum_winners
    UNION ALL BY NAME
    SELECT * FROM mean_winners
)
SELECT
    w.location_id, w.x, w.y, w.geom, w.matrix,
    w.top_depth, w.bottom_depth, w.depth,
    w.fraction, w.meas_basis,
    w.analyte, w.anl_sm_mb, w.analyte_group, w.cas_number,
    w.result, w.detected,
    w.units, w.std_units,
    iu.n_units,
    iu.n_units > 1 AS units_conflict,
    w.rep_sample_date, w.first_sample_date, w.last_sample_date,
    w.n_events, w.n_detects,
    w.detection_limit
FROM winners w
JOIN identity_units iu
    ON  iu.location_id = w.location_id
    AND iu.matrix IS NOT DISTINCT FROM w.matrix
    AND iu.top_depth = w.top_depth
    AND iu.bottom_depth = w.bottom_depth
    AND iu.fraction IS NOT DISTINCT FROM w.fraction
    AND iu.meas_basis IS NOT DISTINCT FROM w.meas_basis
    AND iu.analyte = w.analyte;
