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
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
} from 'cesium';
import {useSql} from '@sqlrooms/duckdb';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {getEntityMetadata} from '../layers/entityMetadata';

export function useLocationClick() {
  const viewer = useChemroomsStore((s) => s.cesium.viewer);
  const setSelectedEntityInSlice = useChemroomsStore(
    (s) => s.chemrooms.setSelectedEntity,
  );
  const setSelectedEntityInCesium = useChemroomsStore(
    (s) => s.cesium.setSelectedEntity,
  );
  const handlerRef = useRef<ScreenSpaceEventHandler | null>(null);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handlerRef.current = handler;

    handler.setInputAction((movement: {position: Cartesian2}) => {
      const picked = viewer.scene.pick(movement.position);
      if (!defined(picked) || !picked.id) {
        // Clicked empty space — deselect in both the cesium slice
        // (used for the "selected" highlight) and the chemrooms
        // slice (used for the Inspector).
        setSelectedEntityInCesium(null);
        setSelectedEntityInSlice(null);
        return;
      }

      const entity = picked.id;

      // Read our metadata off the entity via the WeakMap. If the
      // entity wasn't created by one of our hooks (e.g., a tileset
      // feature or a base-imagery pick), meta will be undefined and
      // we fall back to just flying to it without setting a
      // chemrooms selection.
      const meta = getEntityMetadata(entity);
      if (!meta) {
        setSelectedEntityInSlice(null);
        setSelectedEntityInCesium(null);
      } else if (meta.kind === 'chemduck-location') {
        setSelectedEntityInSlice({
          kind: 'chemduck-location',
          locationId: meta.locationId,
          source: meta.layerId,
        });
        // Chemduck points have a real terrain-aware position, so
        // Cesium's selectionIndicator frames them correctly.
        setSelectedEntityInCesium(entity);
      } else {
        setSelectedEntityInSlice({
          kind: 'vector-feature',
          layerId: meta.layerId,
          featureId: meta.featureId,
          label: meta.label,
          properties: meta.properties,
        });
        // Vector features have hierarchy/polyline positions at
        // ellipsoid height 0 (we strip heights to let
        // clampToGround do the work), so Cesium's bounding-sphere-
        // based selectionIndicator would render below the terrain.
        // The Inspector pane already shows what's selected, so skip
        // the redundant indicator rather than fight the bounding-
        // sphere math. A future session could sample terrain at the
        // centroid to drive a proper indicator position.
        setSelectedEntityInCesium(null);
      }

      viewer.flyTo(entity, {duration: 1.0});
    }, ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      if (!handler.isDestroyed()) {
        handler.destroy();
      }
      handlerRef.current = null;
    };
  }, [viewer, setSelectedEntityInSlice, setSelectedEntityInCesium]);
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
