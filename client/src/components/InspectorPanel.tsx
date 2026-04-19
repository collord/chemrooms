/**
 * Inspector panel — dedicated mosaic pane showing the
 * currently-selected entity.
 *
 * Two variants, switched on selectedEntity.kind:
 *
 *  - `chemduck-location`: the existing LocationDetailCard content
 *    (loc_type, loc_desc, region, sample count, date range,
 *    matrices) plus the analytes-at-location table. Driven by
 *    slice state that useLocationDetail fills in asynchronously
 *    via the summary and analytes SQL queries.
 *
 *  - `vector-feature`: a generic key/value attribute table built
 *    from the entity's `properties` (attached at creation time by
 *    useChemroomsVectorEntities / useChemroomsEntities via the
 *    entityMetadata WeakMap). No SQL needed — the properties
 *    travel with the Cesium entity.
 *
 * Empty state (nothing selected) shows a short placeholder.
 *
 * Replaces the in-sidebar LocationDetailCard — attribute tables
 * can be tall and deserve their own resizable pane rather than
 * fighting the recipe controls for sidebar real estate.
 */

import React, {useCallback} from 'react';
import {
  Calendar,
  FlaskConical,
  Layers as LayersIcon,
  LineChart,
  MapPin,
  MousePointerClick,
  Shapes,
} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {
  AnalyteInfo,
  LocationSummary,
  SelectedEntity,
} from '../slices/chemrooms-slice';

export const InspectorPanel: React.FC = () => {
  const selectedEntity = useChemroomsStore(
    (s) => s.chemrooms.config.selectedEntity,
  );

  if (!selectedEntity) return <EmptyState />;

  if (selectedEntity.kind === 'chemduck-location') {
    return <ChemduckLocationDetail entity={selectedEntity} />;
  }
  return <VectorFeatureDetail entity={selectedEntity} />;
};

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

const EmptyState: React.FC = () => (
  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
    <div className="flex max-w-xs flex-col items-center gap-2">
      <MousePointerClick className="h-6 w-6 opacity-40" />
      <div>Click an entity on the map to inspect its attributes.</div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Chemduck location variant
// ---------------------------------------------------------------------------

const ChemduckLocationDetail: React.FC<{
  entity: Extract<SelectedEntity, {kind: 'chemduck-location'}>;
}> = ({entity}) => {
  const summary = useChemroomsStore((s) => s.chemrooms.locationSummary);
  const analytes = useChemroomsStore((s) => s.chemrooms.analytesAtLocation);
  const isLoading = useChemroomsStore((s) => s.chemrooms.isLoadingLocation);
  const eventAgg = useChemroomsStore((s) => s.chemrooms.config.eventAgg);
  const dupAgg = useChemroomsStore((s) => s.chemrooms.config.dupAgg);
  const ndMethod = useChemroomsStore((s) => s.chemrooms.config.ndMethod);
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      <SelectionHeader
        icon={<MapPin className="h-4 w-4 text-primary" />}
        title={entity.locationId}
        subtitle={entity.source !== 'unknown' ? entity.source : undefined}
      />

      {/* Aggregation context — reminds the user which recipe is
          active so the numbers in the table below make sense. */}
      <AggregationBanner
        eventAgg={eventAgg}
        dupAgg={dupAgg}
        ndMethod={ndMethod}
        coloringAnalyte={coloringAnalyte}
      />

      {/* Clicked point's actual values — the specific row data from
          the aggregate query. Shows the analyte, result value, units,
          detection status, etc. Only present when the clicked entity
          was from an analyte-driven view (not the locations overview). */}
      {entity.rowData && Object.keys(entity.rowData).length > 0 && (
        <ClickedValueCard rowData={entity.rowData} />
      )}

      {isLoading && !summary ? (
        <div className="text-xs italic text-muted-foreground">Loading…</div>
      ) : summary ? (
        <LocationSummaryCard summary={summary} />
      ) : (
        <div className="text-xs italic text-muted-foreground">
          No summary available for this location.
        </div>
      )}

      {analytes.length > 0 && <AnalytesTable analytes={analytes} />}
    </div>
  );
};

/**
 * Shows the active aggregation parameters so the user knows what
 * the per-analyte numbers represent.
 */
const AggregationBanner: React.FC<{
  eventAgg: string;
  dupAgg: string;
  ndMethod: string;
  coloringAnalyte: string | null;
}> = ({eventAgg, dupAgg, ndMethod, coloringAnalyte}) => (
  <div className="flex flex-wrap items-center gap-1.5 rounded bg-muted/50 px-2 py-1.5 text-[10px] text-muted-foreground">
    {coloringAnalyte && (
      <span className="font-medium text-foreground">{coloringAnalyte}</span>
    )}
    <span
      className="rounded bg-background px-1 py-0.5"
      title="Event aggregation"
    >
      {eventAgg}
    </span>
    <span
      className="rounded bg-background px-1 py-0.5"
      title="Duplicate aggregation"
    >
      dup: {dupAgg}
    </span>
    <span
      className="rounded bg-background px-1 py-0.5"
      title="Non-detect method"
    >
      ND: {ndMethod}
    </span>
  </div>
);

const LocationSummaryCard: React.FC<{summary: LocationSummary}> = ({
  summary,
}) => (
  <div className="flex flex-col gap-2 rounded-md border p-3">
    {summary.locType && (
      <span className="w-fit rounded bg-muted px-1.5 py-0.5 text-xs">
        {summary.locType}
      </span>
    )}
    {summary.locDesc && (
      <p className="text-sm text-muted-foreground">{summary.locDesc}</p>
    )}

    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <div className="flex items-center gap-1 text-muted-foreground">
        <LayersIcon className="h-3 w-3" />
        <span>{summary.sampleCount} samples</span>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <FlaskConical className="h-3 w-3" />
        <span>{summary.analyteCount} analytes</span>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <Calendar className="h-3 w-3" />
        <span>{summary.firstDate}</span>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <Calendar className="h-3 w-3" />
        <span>{summary.lastDate}</span>
      </div>
    </div>

    {Array.isArray(summary.matrices) && summary.matrices.length > 0 && (
      <div className="flex flex-wrap gap-1">
        {summary.matrices.map((m) => (
          <span
            key={m}
            className="rounded bg-muted px-1.5 py-0.5 text-xs"
          >
            {m}
          </span>
        ))}
      </div>
    )}
  </div>
);

/**
 * Per-analyte summary table with integrated time-series toggle.
 * Each row shows the aggregated result + a small line-chart icon
 * that adds/removes that analyte from the TimeSeriesPanel.
 */
const AnalytesTable: React.FC<{analytes: AnalyteInfo[]}> = ({analytes}) => {
  const selectedAnalytes = useChemroomsStore(
    (s) => s.chemrooms.config.timeSeriesAnalytes,
  );
  const addAnalyte = useChemroomsStore(
    (s) => s.chemrooms.addTimeSeriesAnalyte,
  );
  const removeAnalyte = useChemroomsStore(
    (s) => s.chemrooms.removeTimeSeriesAnalyte,
  );

  const toggleAnalyte = useCallback(
    (analyte: string) => {
      if (selectedAnalytes.includes(analyte)) {
        removeAnalyte(analyte);
      } else {
        addAnalyte(analyte);
      }
    },
    [selectedAnalytes, addAnalyte, removeAnalyte],
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        Analytes at location ({analytes.length})
      </div>
      <div className="rounded-md border">
        <table className="w-full text-xs">
          <thead className="border-b bg-muted/50">
            <tr className="text-left">
              <th className="px-2 py-1 font-normal">Analyte</th>
              <th className="px-2 py-1 text-right font-normal">Detects</th>
              <th className="px-2 py-1 text-right font-normal">Max</th>
              <th className="px-2 py-1 font-normal">Units</th>
              <th className="w-6 px-1 py-1" />
            </tr>
          </thead>
          <tbody>
            {analytes.map((a) => {
              const isCharted = selectedAnalytes.includes(a.analyte);
              const atLimit = !isCharted && selectedAnalytes.length >= 4;
              return (
                <tr
                  key={a.analyte}
                  className="border-b last:border-b-0 hover:bg-muted/30"
                >
                  <td className="px-2 py-1">
                    <div className="truncate" title={a.analyte}>
                      {a.analyte}
                    </div>
                    {a.analyteGroup && a.analyteGroup !== 'Other' && (
                      <div className="text-[10px] text-muted-foreground">
                        {a.analyteGroup}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {a.detectCount}/{a.resultCount}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {Number.isFinite(a.maxResult)
                      ? a.maxResult.toPrecision(3)
                      : '—'}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {a.units}
                  </td>
                  <td className="px-1 py-1">
                    <button
                      onClick={() => toggleAnalyte(a.analyte)}
                      disabled={atLimit}
                      title={
                        isCharted
                          ? 'Remove from time-series chart'
                          : atLimit
                            ? 'Max 4 analytes charted at once'
                            : 'Show in time-series chart'
                      }
                      className={`rounded p-0.5 transition-colors ${
                        isCharted
                          ? 'text-primary hover:text-primary/70'
                          : 'text-muted-foreground/40 hover:text-foreground disabled:opacity-30'
                      }`}
                    >
                      <LineChart className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * Shows the specific data values from the clicked entity's row —
 * the actual aggregated result the user is looking at. Prominent
 * display of the primary value (analyte + result + units) with
 * secondary metadata (detection status, sample dates, etc.) below.
 */
const ClickedValueCard: React.FC<{rowData: Record<string, unknown>}> = ({
  rowData,
}) => {
  const analyte = rowData.analyte;
  const result = rowData.result;
  const units = rowData.units ?? rowData.std_units;
  const detected = rowData.detected;
  const matrix = rowData.matrix;
  const nEvents = rowData.n_events;
  const repDate = rowData.rep_sample_date;

  const resultStr =
    result != null && Number.isFinite(Number(result))
      ? Number(result).toPrecision(4)
      : '—';
  const unitsStr = units ? ` ${String(units)}` : '';

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      {analyte && (
        <div className="text-xs font-medium text-muted-foreground">
          {String(analyte)}
          {matrix ? ` — ${String(matrix)}` : ''}
        </div>
      )}
      <div className="mt-0.5 text-lg font-bold tabular-nums">
        {resultStr}
        <span className="ml-1 text-sm font-normal text-muted-foreground">
          {unitsStr}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        {detected != null && (
          <span>{detected ? 'Detected' : 'Non-detect'}</span>
        )}
        {nEvents != null && <span>{String(nEvents)} events</span>}
        {repDate != null && <span>{String(repDate)}</span>}
        {rowData.detection_limit != null &&
          Number.isFinite(Number(rowData.detection_limit)) && (
            <span>DL: {Number(rowData.detection_limit).toPrecision(3)}{unitsStr}</span>
          )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Vector feature variant
// ---------------------------------------------------------------------------

const VectorFeatureDetail: React.FC<{
  entity: Extract<SelectedEntity, {kind: 'vector-feature'}>;
}> = ({entity}) => {
  const entries = Object.entries(entity.properties);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      <SelectionHeader
        icon={<Shapes className="h-4 w-4 text-primary" />}
        title={entity.label || entity.featureId}
        subtitle={entity.layerId}
      />

      {entries.length === 0 ? (
        <div className="text-xs italic text-muted-foreground">
          No attribute columns are exposed for this feature. Configure the
          layer's <code>propertiesColumns</code> to pass columns through.
        </div>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-xs">
            <tbody>
              {entries.map(([key, value]) => (
                <tr
                  key={key}
                  className="border-b last:border-b-0 hover:bg-muted/30"
                >
                  <td className="w-1/3 px-2 py-1 font-medium text-muted-foreground">
                    {key}
                  </td>
                  <td className="px-2 py-1 font-mono text-[11px] break-all">
                    {formatPropertyValue(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/**
 * Best-effort string rendering for a property value. Most DuckDB
 * values come through as primitives or null; dates / blobs / lists
 * need a little help. Errs on the side of "show something, don't
 * throw" — if we can't interpret, fall back to JSON.
 */
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Shared selection header
// ---------------------------------------------------------------------------

const SelectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}> = ({icon, title, subtitle}) => (
  <div className="flex items-start gap-2 border-b pb-2">
    {icon}
    <div className="flex min-w-0 flex-col">
      <div className="truncate font-semibold">{title}</div>
      {subtitle && (
        <div className="truncate text-[11px] text-muted-foreground">
          {subtitle}
        </div>
      )}
    </div>
  </div>
);
