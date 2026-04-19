/**
 * Time-series chart panel using @sqlrooms/mosaic VgPlotChart.
 *
 * Displays concentration vs. date for the selected location and analytes.
 * Non-detect handling is applied in the SQL query based on user's chosen method.
 * Supports up to 4 analytes with color encoding.
 */

import React, {useMemo} from 'react';
import {VgPlotChart} from '@sqlrooms/mosaic';
import {useChemroomsStore} from '../slices/chemrooms-slice';

/**
 * Build the SQL query for time-series data, applying non-detect handling
 * inline so the chart gets the correct plot values.
 */
function buildTimeSeriesQuery(
  locationId: string,
  analytes: string[],
  matrixFilter: string | null,
  fractionFilter: string | null,
  ndMethod: string,
): string {
  const analyteList = analytes.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const matrixClause = matrixFilter
    ? `AND s.matrix = '${matrixFilter.replace(/'/g, "''")}'`
    : '';
  const fractionClause = fractionFilter
    ? `AND r.fraction = '${fractionFilter.replace(/'/g, "''")}'`
    : '';
  const ndExcludeClause =
    ndMethod === 'exclude' ? 'AND r.detected = TRUE' : '';

  let ndExpression: string;
  switch (ndMethod) {
    case 'half_dl':
      ndExpression = `CASE
        WHEN r.detected THEN r.result
        ELSE COALESCE(r.reporting_limit, r.method_detection_limit, r.quantitation_limit) / 2.0
      END`;
      break;
    case 'dl':
      ndExpression = `CASE
        WHEN r.detected THEN r.result
        ELSE COALESCE(r.reporting_limit, r.method_detection_limit, r.quantitation_limit)
      END`;
      break;
    case 'zero':
      ndExpression = `CASE WHEN r.detected THEN r.result ELSE 0 END`;
      break;
    default: // 'exclude' — non-detects are filtered out in WHERE
      ndExpression = `r.result`;
      break;
  }

  // Cast sample_date to VARCHAR so it arrives as an ISO 8601
  // string in JS — Observable Plot (via VgPlotChart) can auto-
  // parse ISO strings as dates but chokes on epoch numbers or
  // DuckDB's typed DATE values that Arrow serializes as integers.
  return `
    SELECT
      r.analyte,
      CAST(s.sample_date AS VARCHAR) AS sample_date,
      (${ndExpression}) AS plot_value,
      r.result,
      r.detected,
      COALESCE(r.reporting_limit, r.method_detection_limit, r.quantitation_limit)
        AS detection_limit,
      COALESCE(r.units, '') AS units,
      COALESCE(r.qualifier, '') AS qualifier,
      CASE WHEN r.detected THEN 'Detected' ELSE 'Non-Detect' END AS detect_status
    FROM results r
    JOIN samples s ON r.sample_id = s.sample_id
    WHERE s.location_id = '${locationId.replace(/'/g, "''")}'
      AND r.analyte IN (${analyteList})
      ${matrixClause}
      ${fractionClause}
      ${ndExcludeClause}
    ORDER BY r.analyte, s.sample_date
  `;
}

export const TimeSeriesPanel: React.FC = () => {
  // Time series is a chemduck-only concept — it's the
  // sample_date/result chart for a specific location. For
  // vector-feature selections it stays blank, same as when nothing
  // is selected at all.
  const selectedEntity = useChemroomsStore(
    (s) => s.chemrooms.config.selectedEntity,
  );
  // The entity's locationId may be a composite from the aggregate
  // query: "SYN-0188|Water|0.0|0.0". The time-series SQL query
  // needs just the base location_id ("SYN-0188").
  const rawLocationId =
    selectedEntity?.kind === 'chemduck-location'
      ? selectedEntity.locationId
      : null;
  const selectedLocationId = rawLocationId?.split('|')[0] ?? null;
  const selectedAnalytes = useChemroomsStore(
    (s) => s.chemrooms.config.timeSeriesAnalytes,
  );
  const matrixFilter = useChemroomsStore(
    (s) => s.chemrooms.config.matrixFilter,
  );
  const fractionFilter = useChemroomsStore(
    (s) => s.chemrooms.config.fractionFilter,
  );
  const ndMethod = useChemroomsStore((s) => s.chemrooms.config.ndMethod);
  const mosaicConn = useChemroomsStore((s) => s.mosaic.connection);

  const hasSelection =
    selectedLocationId && selectedAnalytes.length > 0;

  // Build VgPlot spec (declarative Mosaic spec)
  const spec = useMemo(() => {
    if (!hasSelection || mosaicConn.status !== 'ready') return null;

    const query = buildTimeSeriesQuery(
      selectedLocationId!,
      selectedAnalytes,
      matrixFilter,
      fractionFilter,
      ndMethod,
    );

    return {
      data: {
        ts_data: {type: 'table' as const, query},
      },
      plot: [
        {
          mark: 'lineY',
          data: {from: 'ts_data'},
          x: 'sample_date',
          y: 'plot_value',
          stroke: 'analyte',
          strokeWidth: 1.5,
        },
        {
          mark: 'dot',
          data: {from: 'ts_data'},
          x: 'sample_date',
          y: 'plot_value',
          fill: 'analyte',
          r: 4,
          tip: true,
        },
      ],
      xLabel: 'Sample Date',
      yLabel: 'Concentration',
      colorLegend: true,
      width: 800,
      height: 300,
    };
  }, [
    hasSelection,
    selectedLocationId,
    selectedAnalytes,
    matrixFilter,
    fractionFilter,
    ndMethod,
    mosaicConn.status,
  ]);

  if (mosaicConn.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Initializing chart engine...
      </div>
    );
  }

  if (mosaicConn.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        Chart engine error. Try reloading.
      </div>
    );
  }

  if (!hasSelection) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a location on the map, then choose analytes to view time-series
        data.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto p-2">
      <div className="mb-2 text-xs text-muted-foreground">
        <span className="font-medium">{selectedLocationId}</span>
        {' — '}
        {selectedAnalytes.join(', ')}
      </div>
      {spec ? (
        <div className="min-h-[200px] flex-1">
          <VgPlotChart spec={spec as any} />
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">Building chart...</div>
      )}
    </div>
  );
};
