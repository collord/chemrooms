/**
 * Time-series chart panel using @sqlrooms/mosaic VgPlotChart.
 *
 * Displays concentration vs. date for the selected location and analytes:
 * ChemDuck's point_series (setup/buildTimeSeriesSql.ts), one line per
 * measurement point, non-detects drawn by the map's display choice and
 * marked. Supports up to 4 analytes with color encoding.
 */

import {selectChemduckReady} from '../slices/selectors';
import React, {useMemo} from 'react';
import {VgPlotChart} from '@sqlrooms/mosaic';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {buildTimeSeriesSql} from '../setup/buildTimeSeriesSql';

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
  const rowScope = useChemroomsStore((s) => s.chemrooms.config.rowScope);
  const mosaicConn = useChemroomsStore((s) => s.mosaic.connection);
  // point_series is defined by init; a location from the URL asks sooner.
  const chemduckReady = useChemroomsStore(selectChemduckReady);

  const hasSelection =
    selectedLocationId && selectedAnalytes.length > 0;

  // Build VgPlot spec (declarative Mosaic spec)
  const spec = useMemo(() => {
    if (!hasSelection || mosaicConn.status !== 'ready' || !chemduckReady) return null;

    const query = buildTimeSeriesSql({
      locationId: selectedLocationId!,
      analytes: selectedAnalytes,
      matrixFilter,
      fractionFilter,
      ndMethod,
      rowScope,
    });

    console.log('[timeseries] query:', query);

    // Use a unique table name per query so Mosaic doesn't serve
    // stale cached data when the analyte selection changes. Without
    // this, Mosaic sees "ts_data" and reuses the previous result
    // even though the underlying SQL is different.
    const tableKey = `ts_${selectedLocationId}_${selectedAnalytes.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_');

    return {
      data: {
        [tableKey]: {type: 'table' as const, query},
      },
      // A legend: each line is one measurement point (a depth interval,
      // a fraction, a method class), and only its name says which.
      vconcat: [
        {legend: 'color', for: 'timeseries'},
        {
          name: 'timeseries',
          plot: [
            {
              mark: 'line',
              data: {from: tableKey},
              x: 'sample_date',
              y: 'plot_value',
              // One line per measurement point (buildTimeSeriesSql): depth
              // intervals, fractions and method classes are never joined.
              z: 'series',
              stroke: 'series',
              strokeWidth: 2,
            },
            {
              mark: 'dot',
              data: {from: tableKey},
              x: 'sample_date',
              y: 'plot_value',
              fill: 'series',
              // A non-detect is drawn at its display value, and marked as one.
              symbol: 'detect_status',
              r: 4,
              tip: true,
            },
          ],
          // sample_date arrives as an ISO string (buildTimeSeriesSql); without a
          // time scale Plot treated it as ordinal ("strings that appear to be
          // dates"), spacing samples evenly whatever their dates.
          xScale: 'utc',
          xLabel: 'Sample Date',
          yLabel: 'Concentration',
          xTickRotate: -25,
          marginBottom: 80,
          width: 800,
          height: 350,
        },
      ],
    };
  }, [
    hasSelection,
    selectedLocationId,
    selectedAnalytes,
    matrixFilter,
    fractionFilter,
    ndMethod,
    rowScope,
    mosaicConn.status,
    chemduckReady,
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
    <div className="ts-chart-container flex h-full flex-col overflow-auto p-2">
      {/* Observable Plot tooltip dark-theme overrides. The tip mark
          renders a foreignObject <div> with inline white background +
          dark text. We force dark colors with !important. The
          .ts-chart-container scope keeps these overrides local. */}
      <style>{`
        .ts-chart-container [class*="plot"] foreignObject div,
        .ts-chart-container figure foreignObject div,
        .ts-chart-container svg foreignObject div {
          background: hsl(222 47% 11%) !important;
          color: hsl(210 40% 96%) !important;
          border-color: hsl(217 33% 25%) !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
        }
      `}</style>
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
