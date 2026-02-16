/**
 * Loads available filter options (analytes, matrices, screening levels)
 * from DuckDB once the data tables are ready.
 */

import {useEffect} from 'react';
import {useSql} from '@sqlrooms/duckdb';
import {useChemroomsStore} from '../slices/chemrooms-slice';

export function useAvailableFilters() {
  const resultsTable = useChemroomsStore((s) =>
    s.db.findTableByName('results'),
  );
  const samplesTable = useChemroomsStore((s) =>
    s.db.findTableByName('samples'),
  );
  const screeningTable = useChemroomsStore((s) =>
    s.db.findTableByName('screening_levels'),
  );

  const tablesReady = Boolean(resultsTable && samplesTable);

  const setAvailableMatrices = useChemroomsStore(
    (s) => s.chemrooms.setAvailableMatrices,
  );
  const setAvailableAnalytes = useChemroomsStore(
    (s) => s.chemrooms.setAvailableAnalytes,
  );
  const setAvailableScreeningLevels = useChemroomsStore(
    (s) => s.chemrooms.setAvailableScreeningLevels,
  );
  const setIsLoadingFilters = useChemroomsStore(
    (s) => s.chemrooms.setIsLoadingFilters,
  );

  // Matrices
  const {data: matricesData} = useSql<{matrix: string}>({
    query: `SELECT DISTINCT matrix FROM samples ORDER BY matrix`,
    enabled: tablesReady,
  });

  // Analytes with counts
  const {data: analytesData} = useSql<{
    analyte: string;
    analyte_group: string;
    cas_number: string;
    result_count: number;
    detect_count: number;
    min_result: number;
    max_result: number;
    units: string;
  }>({
    query: `
      SELECT
        r.analyte,
        COALESCE(r.analyte_group, 'Other') AS analyte_group,
        COALESCE(r.cas_number, '') AS cas_number,
        COUNT(*)::INT AS result_count,
        SUM(CASE WHEN r.detected THEN 1 ELSE 0 END)::INT AS detect_count,
        MIN(r.result) AS min_result,
        MAX(r.result) AS max_result,
        COALESCE(r.units, '') AS units
      FROM results r
      JOIN samples s ON r.sample_id = s.sample_id
      GROUP BY r.analyte, r.analyte_group, r.cas_number, r.units
      ORDER BY COALESCE(r.analyte_group, 'Other'), r.analyte
    `,
    enabled: tablesReady,
  });

  // Screening levels
  const {data: screeningData} = useSql<{name: string}>({
    query: `SELECT DISTINCT name FROM screening_levels ORDER BY name`,
    enabled: Boolean(screeningTable),
  });

  useEffect(() => {
    if (matricesData) {
      setAvailableMatrices(matricesData.toArray().map((r) => r.matrix));
    }
  }, [matricesData, setAvailableMatrices]);

  useEffect(() => {
    if (analytesData) {
      setAvailableAnalytes(
        analytesData.toArray().map((r) => ({
          analyte: r.analyte,
          analyteGroup: r.analyte_group,
          casNumber: r.cas_number,
          resultCount: r.result_count,
          detectCount: r.detect_count,
          minResult: r.min_result,
          maxResult: r.max_result,
          units: r.units,
        })),
      );
      setIsLoadingFilters(false);
    }
  }, [analytesData, setAvailableAnalytes, setIsLoadingFilters]);

  useEffect(() => {
    if (screeningData) {
      setAvailableScreeningLevels(
        screeningData.toArray().map((r) => r.name),
      );
    }
  }, [screeningData, setAvailableScreeningLevels]);
}
