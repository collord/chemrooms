/**
 * Cesium entity click → chemrooms selection.
 *
 * One viewer-level screen-space click handler picks whatever the
 * user clicked, inspects the entity's metadata (attached at entity
 * creation by useChemroomsEntities / useChemroomsVectorEntities),
 * and pushes a typed SelectedEntity into the slice. Clicking empty
 * space deselects.
 *
 * The slice's selectedEntity then drives two things:
 *  - The Inspector panel (rendered in the mosaic layout) which
 *    shows a chemduck-location summary OR a generic vector-feature
 *    attributes table depending on kind.
 *  - useLocationDetail (below), which fires the summary + analytes
 *    SQL queries when the selection is a chemduck-location.
 *
 * Old name `useLocationClick` is preserved for backwards-compatible
 * imports; the implementation no longer assumes the clicked entity
 * is a chemduck location.
 */

import {useEffect, useRef} from 'react';
import {
  Cartesian2,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
  type Viewer,
} from 'cesium';
import {useSql} from '@sqlrooms/duckdb';
import {
  useChemroomsStore,
  type SelectedEntity,
} from '../slices/chemrooms-slice';
import {getEntityMetadata} from '../layers/entityMetadata';

/**
 * Selection highlight color — applied imperatively to the outline
 * of the currently-selected vector feature. Yellow has good
 * contrast against cyan and against most terrain.
 */
const SELECTED_OUTLINE = Color.YELLOW;
/** Multiplier on the feature's normal outline width when selected. */
const SELECTED_WIDTH_BOOST = 2;

/**
 * Walk the viewer's entities and apply the correct selection
 * highlight based on the current selection. Covers:
 *
 * - **Vector-feature polylines** (standalone + polygon outlines):
 *   material + width swap, same as before.
 *
 * - **Chemduck 3D primitives** (ellipsoid spheres + polylineVolume
 *   borehole tubes): material swap to SELECTED_OUTLINE on select,
 *   revert to the row's normalColor on deselect. The normalColor
 *   is stored in metadata at creation time because these entities
 *   use per-row data-driven color (from the vis spec colorBy
 *   pipeline) and there's no one fallback color to revert to.
 *
 * - **2D point fallback**: no restyle. Screen-space points don't
 *   need material swaps; they're small enough that the Inspector
 *   pane is sufficient as a "what's selected" signal.
 *
 * We iterate viewer.entities.values — O(N) but N is typically
 * < 1000 and selection changes are user-paced, not per-frame.
 */
function applySelectionStyle(
  viewer: Viewer,
  sel: SelectedEntity | null,
): void {
  for (const entity of viewer.entities.values) {
    const meta = getEntityMetadata(entity);
    if (!meta) continue;

    // ── Vector-feature polyline outlines ──────────────────────
    if (meta.kind === 'vector-feature' && meta.outlineStyle && entity.polyline) {
      const isSelected =
        sel?.kind === 'vector-feature' &&
        sel.layerId === meta.layerId &&
        sel.featureId === meta.featureId;
      const color = isSelected
        ? SELECTED_OUTLINE
        : meta.outlineStyle.normalColor;
      const width = isSelected
        ? meta.outlineStyle.normalWidth * SELECTED_WIDTH_BOOST
        : meta.outlineStyle.normalWidth;
      entity.polyline.material = new ColorMaterialProperty(color);
      entity.polyline.width = new ConstantProperty(width);
    }

    // ── Chemduck 3D ellipsoid (sphere) ───────────────────────
    if (
      meta.kind === 'chemduck-location' &&
      meta.primitiveType === 'ellipsoid' &&
      meta.normalColor &&
      entity.ellipsoid
    ) {
      const isSelected =
        sel?.kind === 'chemduck-location' &&
        sel.locationId === meta.locationId;
      entity.ellipsoid.material = new ColorMaterialProperty(
        isSelected ? SELECTED_OUTLINE : meta.normalColor,
      );
    }

    // ── Chemduck 3D polylineVolume (borehole tube) ───────────
    if (
      meta.kind === 'chemduck-location' &&
      meta.primitiveType === 'polylineVolume' &&
      meta.normalColor &&
      entity.polylineVolume
    ) {
      const isSelected =
        sel?.kind === 'chemduck-location' &&
        sel.locationId === meta.locationId;
      entity.polylineVolume.material = new ColorMaterialProperty(
        isSelected ? SELECTED_OUTLINE : meta.normalColor,
      );
    }
  }
}

/**
 * React hook: subscribe to selection changes and apply the
 * highlight to all entity types. Mounted alongside useLocationClick.
 */
function useSelectionHighlight() {
  const viewer = useChemroomsStore((s) => s.cesium.viewer);
  const selectedEntity = useChemroomsStore(
    (s) => s.chemrooms.config.selectedEntity,
  );
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    applySelectionStyle(viewer, selectedEntity);
  }, [viewer, selectedEntity]);
}

export function useLocationClick() {
  // Mount the selection highlight + indicator-disable effects
  // alongside the click handler — they share a single lifecycle
  // on the viewer.
  useSelectionHighlight();
  useDisableCesiumSelectionIndicator();

  const viewer = useChemroomsStore((s) => s.cesium.viewer);
  const setSelectedEntityInSlice = useChemroomsStore(
    (s) => s.chemrooms.setSelectedEntity,
  );
  const handlerRef = useRef<ScreenSpaceEventHandler | null>(null);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handlerRef.current = handler;

    handler.setInputAction((movement: {position: Cartesian2}) => {
      const picked = viewer.scene.pick(movement.position);
      if (!defined(picked) || !picked.id) {
        // Clicked empty space — deselect. The Cesium selection
        // indicator is disabled elsewhere, so there's nothing to
        // clear on that side.
        setSelectedEntityInSlice(null);
        return;
      }

      const entity = picked.id;

      // Read our metadata off the entity via the WeakMap. If the
      // entity wasn't created by one of our hooks (e.g., a tileset
      // feature or a base-imagery pick), meta will be undefined and
      // we fall back to just flying to it without setting a
      // chemrooms selection. We no longer touch viewer.selectedEntity
      // at all — Cesium's selection indicator is disabled globally
      // (see useDisableCesiumSelectionIndicator below) because
      // (a) it positions incorrectly for terrain-clamped vector
      // features and (b) the Inspector pane already serves as the
      // "what's selected" signal.
      const meta = getEntityMetadata(entity);
      if (!meta) {
        setSelectedEntityInSlice(null);
      } else if (meta.kind === 'chemduck-location') {
        setSelectedEntityInSlice({
          kind: 'chemduck-location',
          locationId: meta.locationId,
          source: meta.layerId,
        });
      } else {
        setSelectedEntityInSlice({
          kind: 'vector-feature',
          layerId: meta.layerId,
          featureId: meta.featureId,
          label: meta.label,
          properties: meta.properties,
        });
      }

      viewer.flyTo(entity, {duration: 1.0});
    }, ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      if (!handler.isDestroyed()) {
        handler.destroy();
      }
      handlerRef.current = null;
    };
  }, [viewer, setSelectedEntityInSlice]);
}

/**
 * Disable Cesium's built-in selection indicator (the green
 * rectangle widget). The Inspector pane is the canonical "what's
 * selected" signal; the indicator's bounding-sphere-based
 * positioning also renders incorrectly for terrain-clamped vector
 * features (below the terrain, at ellipsoid height). Kill both.
 *
 * Belt-and-suspenders: we set `showSelection = false` on the view
 * model AND hide the DOM container, because Cesium sometimes
 * re-positions the indicator on internal clock ticks even when the
 * view model says don't show.
 */
function useDisableCesiumSelectionIndicator(): void {
  const viewer = useChemroomsStore((s) => s.cesium.viewer);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const indicator = viewer.selectionIndicator;
    if (!indicator) return;
    // Toggle the viewmodel flag so Cesium's own rendering loop
    // doesn't try to position the indicator.
    try {
      (indicator.viewModel as {showSelection: boolean}).showSelection = false;
    } catch {
      // Older Cesium versions or read-only accessor — fall through
      // to the DOM-hide path below.
    }
    // Hide the widget's container so even if Cesium flips
    // showSelection back on internally, nothing actually renders.
    if (indicator.container instanceof HTMLElement) {
      indicator.container.style.display = 'none';
    }
  }, [viewer]);
}

/**
 * Loads location summary + analyte list when the selection is a
 * chemduck-location. No-ops for vector-feature selections (those
 * have no server-side summary to fetch — their properties travel
 * with the Cesium entity).
 */
export function useLocationDetail() {
  const selectedEntity = useChemroomsStore(
    (s) => s.chemrooms.config.selectedEntity,
  );
  const selectedLocationId =
    selectedEntity?.kind === 'chemduck-location'
      ? selectedEntity.locationId
      : null;
  const matrixFilter = useChemroomsStore(
    (s) => s.chemrooms.config.matrixFilter,
  );
  const fractionFilter = useChemroomsStore(
    (s) => s.chemrooms.config.fractionFilter,
  );
  const setLocationSummary = useChemroomsStore(
    (s) => s.chemrooms.setLocationSummary,
  );
  const setAnalytesAtLocation = useChemroomsStore(
    (s) => s.chemrooms.setAnalytesAtLocation,
  );
  const setIsLoadingLocation = useChemroomsStore(
    (s) => s.chemrooms.setIsLoadingLocation,
  );

  const locationsTable = useChemroomsStore((s) =>
    s.db.findTableByName('locations'),
  );

  // Location summary query
  const {data: summaryData, isLoading: summaryLoading} = useSql<{
    location_id: string;
    loc_type: string;
    loc_desc: string;
    region: string;
    sample_count: number;
    analyte_count: number;
    first_date: string;
    last_date: string;
    matrices: string[];
  }>({
    query: `
      SELECT
        l.location_id,
        COALESCE(l.loc_type, '') AS loc_type,
        COALESCE(l.loc_desc, '') AS loc_desc,
        COALESCE(l.region, '') AS region,
        COUNT(DISTINCT s.sample_id)::INT AS sample_count,
        COUNT(DISTINCT r.analyte)::INT AS analyte_count,
        MIN(s.sample_date)::VARCHAR AS first_date,
        MAX(s.sample_date)::VARCHAR AS last_date,
        LIST(DISTINCT s.matrix ORDER BY s.matrix) AS matrices
      FROM locations l
      JOIN samples s ON s.location_id = l.location_id
      JOIN results r ON r.sample_id = s.sample_id
      WHERE l.location_id = '${selectedLocationId}'
      GROUP BY l.location_id, l.loc_type, l.loc_desc, l.region
    `,
    enabled: Boolean(selectedLocationId) && Boolean(locationsTable),
  });

  // Analytes at this location
  const matrixClause = matrixFilter ? `AND s.matrix = '${matrixFilter}'` : '';
  const fractionClause = fractionFilter
    ? `AND r.fraction = '${fractionFilter}'`
    : '';

  const {data: analytesData, isLoading: analytesLoading} = useSql<{
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
      WHERE s.location_id = '${selectedLocationId}'
        ${matrixClause}
        ${fractionClause}
      GROUP BY r.analyte, r.analyte_group, r.cas_number, r.units
      ORDER BY COALESCE(r.analyte_group, 'Other'), r.analyte
    `,
    enabled: Boolean(selectedLocationId) && Boolean(locationsTable),
  });

  useEffect(() => {
    setIsLoadingLocation(summaryLoading || analytesLoading);
  }, [summaryLoading, analytesLoading, setIsLoadingLocation]);

  useEffect(() => {
    if (summaryData) {
      const row = summaryData.toArray()[0];
      if (row) {
        setLocationSummary({
          locationId: row.location_id,
          locType: row.loc_type,
          locDesc: row.loc_desc,
          region: row.region,
          sampleCount: row.sample_count,
          analyteCount: row.analyte_count,
          firstDate: row.first_date,
          lastDate: row.last_date,
          matrices: Array.isArray(row.matrices)
            ? row.matrices
            : row.matrices?.toArray?.() ?? [],
        });
      }
    } else if (!selectedLocationId) {
      setLocationSummary(null);
    }
  }, [summaryData, selectedLocationId, setLocationSummary]);

  useEffect(() => {
    if (analytesData) {
      setAnalytesAtLocation(
        analytesData.toArray().map((r: {
          analyte: string;
          analyte_group: string;
          cas_number: string;
          result_count: number;
          detect_count: number;
          min_result: number;
          max_result: number;
          units: string;
        }) => ({
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
    }
  }, [analytesData, setAnalytesAtLocation]);
}
