-- analyte_catalog from ChemDuck's own catalogue, for an ARII folder that
-- doesn't carry chemrooms' (chemrooms_catalogs.sql).
--
-- A folder the QGIS plugin's pipeline publishes (`chemduck/`) has
-- analyte_summary, ChemDuck's v_analyte_summary materialized at publish,
-- and not chemrooms' analyte_catalog. Building analyte_catalog from
-- `results` would scan every remote partition to fill a dropdown, so it is
-- built from the summary instead. That summary is grouped by variable
-- (analyte, matrix, fraction, basis, method class, unit), so its counts sum
-- to the same totals per (analyte, unit).
--
-- What it can't carry: analyte_group and cas_number, which v_analyte_summary
-- doesn't keep. Every analyte is in group 'Other' with no CAS, which is
-- also what an EQuIS export without ANALYTE_TYPE gives today.
--
-- Units are the summary's std_units, the unit after ChemDuck's load-time
-- conversion; chemrooms' own catalog groups by the reported unit.
CREATE OR REPLACE VIEW analyte_catalog AS
SELECT
    analyte,
    'Other' AS analyte_group,
    '' AS cas_number,
    COALESCE(std_units, '') AS units,
    SUM(n_results)::INTEGER AS result_count,
    SUM(n_detect)::INTEGER AS detect_count,
    MIN(min_result) AS min_result,
    MAX(max_result) AS max_result
FROM analyte_summary
GROUP BY analyte, std_units;
