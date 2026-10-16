-- Chemrooms catalogs: the per-analyte and per-location summaries the UI
-- reads to fill its pickers and the location inspector.
--
-- Defined once, here, as views over the ChemDuck tables. For a converted
-- ChemDuck project the client creates them as live views (cheap: the data
-- is local). For an EQuIS ARII project `results` is a view over remote
-- parquet, and a query that groups every result would download the whole
-- facility, so the ARII publisher materializes these same views as
-- same-named sidecar tables:
--
--     python ../chemduck/tools/arii_hybrid.py publish <manifest> <out> \
--         --materialize client/src/sql/chemrooms_catalogs.sql
--
-- and the client skips this file when the tables are already there. Either
-- way the UI queries one name with one set of columns.
--
-- This file ships with the client (imported with ?raw), not the data
-- folder: it is chemrooms' code, while the ChemDuck SQL travels with the
-- data it was published against.
--
-- Counts include every sample type, as the queries they replace did.

-- One row per analyte as it is reported (group, CAS and unit together).
CREATE OR REPLACE VIEW analyte_catalog AS
SELECT
    r.analyte,
    COALESCE(r.analyte_group, 'Other') AS analyte_group,
    COALESCE(r.cas_number, '') AS cas_number,
    COALESCE(r.units, '') AS units,
    COUNT(*)::INTEGER AS result_count,
    SUM(CASE WHEN r.detected THEN 1 ELSE 0 END)::INTEGER AS detect_count,
    MIN(r.result) AS min_result,
    MAX(r.result) AS max_result
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
GROUP BY r.analyte, r.analyte_group, r.cas_number, r.units;

-- One row per (location, matrix, fraction, analyte as reported): what the
-- inspector lists when a location is clicked, filtered by the active
-- matrix and fraction. Fraction is kept apart, never summed across.
CREATE OR REPLACE VIEW location_analytes AS
SELECT
    s.location_id,
    s.matrix,
    r.fraction,
    r.analyte,
    COALESCE(r.analyte_group, 'Other') AS analyte_group,
    COALESCE(r.cas_number, '') AS cas_number,
    COALESCE(r.units, '') AS units,
    COUNT(*)::INTEGER AS result_count,
    SUM(CASE WHEN r.detected THEN 1 ELSE 0 END)::INTEGER AS detect_count,
    MIN(r.result) AS min_result,
    MAX(r.result) AS max_result
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
GROUP BY s.location_id, s.matrix, r.fraction, r.analyte, r.analyte_group,
         r.cas_number, r.units;
