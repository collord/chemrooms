/**
 * Loads available filter options (analytes, matrices, screening levels)
 * from DuckDB once the data tables are ready.
 */

import {selectChemduckReady} from '../slices/selectors';
import {useEffect} from 'react';
import {useSql} from '@sqlrooms/duckdb';
import {useChemroomsStore} from '../slices/chemrooms-slice';

export function useAvailableFilters() {
  // analyte_catalog exists once init has loaded the ChemDuck schema and
  // chemrooms' catalogs (a view, or an ARII sidecar table).
  const hasSchema = useChemroomsStore(selectChemduckReady);
  const samplesTable = useChemroomsStore((s) =>
    s.db.findTableByName('samples'),
  );
  const screeningTable = useChemroomsStore((s) =>
    s.db.findTableByName('screening_levels'),
  );

  const tablesReady = Boolean(samplesTable);

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
    // From analyte_catalog rather than grouping `results`: for an ARII
    // project that would scan every remote partition.
    query: `
      SELECT analyte, analyte_group, cas_number, result_count, detect_count,
             min_result, max_result, units
      FROM analyte_catalog
      ORDER BY analyte_group, analyte
    `,
    enabled: tablesReady && hasSchema,
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
