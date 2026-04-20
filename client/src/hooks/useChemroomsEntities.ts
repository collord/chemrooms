/**
 * Imperative Cesium entity rendering for chemrooms layers.
 *
 * Bypasses @sqlrooms/cesium's CesiumEntityLayer (which hardcodes
 * Color.CYAN) so we can apply per-row colors derived from the active
 * vis spec. The hook owns the lifecycle of one set of entities tagged
 * with `layerId` — when any input changes, the existing entities are
 * removed and a fresh set is created from the latest query results.
 *
 * Color resolution:
 *   1. Lookup the vis spec for `visSpecTable`
 *   2. Lookup the active colorBy column for that table
 *   3. If both exist, derive a domain (sequential) or category list
 *      (categorical) from the live data and build a color function
 *   4. Otherwise fall back to cyan
 *
 * The derived domain wins over the spec's hardcoded one — see the note
 * in vis/colormap.ts for why.
 */

import {useEffect} from 'react';
import {Cartesian2, Cartesian3, Color, HeightReference} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {makeColorFnForColumn} from '../vis/colormap';
import {
  setEntityMetadata,
  stripPositioningColumns,
} from '../layers/entityMetadata';
import {fabricateTrajectory} from '../layers/desurvey';
import {BboxAccumulator, setLayerBbox} from '../layers/layerBbox';

// Cross-section polygon for borehole tubes. 6 sides (hexagon) is
// visually indistinguishable from round at the scale we render
// (1-5m radius, viewed from tens to hundreds of meters) and
// produces half the geometry of 12. Can go as low as 4 (square)
// for extreme performance but the facets become visible up close.
const VOLUME_SHAPE_SEGMENTS = 6;

function circleShape(radiusMeters: number): Cartesian2[] {
  const positions: Cartesian2[] = [];
  for (let i = 0; i < VOLUME_SHAPE_SEGMENTS; i++) {
    const angle = (i / VOLUME_SHAPE_SEGMENTS) * Math.PI * 2;
    positions.push(
      new Cartesian2(
        Math.cos(angle) * radiusMeters,
        Math.sin(angle) * radiusMeters,
      ),
    );
  }
  return positions;
}

export interface UseChemroomsEntitiesArgs {
  /** Stable string used to namespace entity IDs and clean them up. */
  layerId: string;
  /** SQL to run. Must produce columns: location_id, longitude, latitude, altitude, label. */
  sqlQuery: string | null;
  /** Vis spec table key to look up palette for. */
  visSpecTable: string;
  /** Whether the layer should render. */
  visible: boolean;
  /**
   * Optional override for the colorBy column. When provided, it takes
   * precedence over the slice's colorBy[visSpecTable] value. Used by
   * personal/saved layers that store their own colorBy in the layer
   * config rather than the global slice state.
   */
  colorByOverride?: string | null;
  /**
   * What kind of entity these rows represent. Drives click-handler
   * behavior: chemduck-location triggers the structured summary
   * queries in useLocationDetail; vector-feature carries its
   * attributes inline via the entity metadata WeakMap. Defaults to
   * 'chemduck-location' because the built-in chemrooms layers
   * (locations, samples, and chemduck-recipe personal/bookmark
   * layers) are the common case.
   */
  entityKind?: 'chemduck-location' | 'vector-feature';
  /**
   * 3D rendering mode for chemduck-sourced entities.
   * - `auto` (default): sphere for surface, polylineVolume for depth intervals
   * - `sphere`: always sphere (ignore depth)
   * - `volume`: always polylineVolume
   */
  sampleRenderAs?: 'auto' | 'sphere' | 'volume';
  /** Radius of 3D spheres in meters. Default 3. */
  sphereRadiusMeters?: number;
  /** Radius of borehole polylineVolume cross-section in meters. Default 1. */
  volumeRadiusMeters?: number;
}

const FALLBACK_COLOR = Color.CYAN;

export function useChemroomsEntities(args: UseChemroomsEntitiesArgs) {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const connector = useStoreWithCesium((s) => s.db.connector);
  const visSpec = useChemroomsStore(
    (s) => s.chemrooms.visSpecs[args.visSpecTable],
  );
  const sliceColorBy = useChemroomsStore(
    (s) => s.chemrooms.colorBy[args.visSpecTable],
  );
  const colorByCol =
    args.colorByOverride !== undefined ? args.colorByOverride : sliceColorBy;

  useEffect(() => {
    if (
      !viewer ||
      viewer.isDestroyed() ||
      !connector ||
      !args.sqlQuery ||
      !args.visible
    ) {
      return;
    }

    let cancelled = false;
    const created: Array<{id: string}> = [];

    (async () => {
      let rows: any[] = [];
      try {
        const result = await connector.query(args.sqlQuery!);
        rows = result.toArray();
      } catch (e) {
        console.error(`[${args.layerId}] query failed:`, e);
        return;
      }
      if (cancelled || rows.length === 0) return;

      // Resolve color function from the active vis spec + colorBy column.
      let colorFn: (val: unknown) => Color = () => FALLBACK_COLOR;
      const colSpec =
        visSpec && colorByCol ? visSpec.columns[colorByCol] : undefined;
      if (colSpec && colorByCol) {
        if (colSpec.color.type === 'sequential') {
          // Derive domain from live values
          const vals = rows
            .map((r) => Number(r[colorByCol]))
            .filter((v) => Number.isFinite(v));
          const domain: [number, number] | undefined =
            vals.length > 0
              ? [Math.min(...vals), Math.max(...vals)]
              : undefined;
          colorFn = makeColorFnForColumn(colSpec, domain);
        } else if (colSpec.color.type === 'categorical') {
          // Derive distinct categories from live values
          const seen = new Set<string>();
          for (const r of rows) {
            const v = r[colorByCol];
            if (v != null) seen.add(String(v));
          }
          const cats = Array.from(seen).sort();
          colorFn = makeColorFnForColumn(colSpec, undefined, cats);
        }
      }

      // First pass: compute the spatial extent from the data positions.
      // This drives both the project bbox (for initial zoom) and the
      // dynamic sphere radius (0.01 × extent so spheres are visible
      // at whatever zoom shows the full dataset).
      const bboxAcc = new BboxAccumulator();
      for (const row of rows) {
        const lon = Number(row.longitude);
        const lat = Number(row.latitude);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          bboxAcc.add(lon, lat);
        }
      }
      const layerBbox = bboxAcc.toBbox();
      setLayerBbox(args.layerId, layerBbox);

      // Precompute 3D rendering shapes (reused across rows).
      const isChemduck =
        (args.entityKind ?? 'chemduck-location') === 'chemduck-location';
      const renderMode = args.sampleRenderAs ?? 'auto';
      const volumeR = args.volumeRadiusMeters ?? 1;

      // Dynamic sphere radius: 1% of the data extent in meters.
      // At mid-latitudes, 1 degree ≈ 111km. This gives spheres
      // that are visible at the overview zoom level regardless of
      // how large the site is. Falls back to 2m if the bbox is
      // degenerate (single point).
      const DEG_TO_METERS = 111_000;
      const RADIUS_FRACTION = 0.01;
      let sphereR: number;
      if (layerBbox) {
        const extentDeg = Math.max(
          layerBbox.east - layerBbox.west,
          layerBbox.north - layerBbox.south,
        );
        const extentMeters = extentDeg * DEG_TO_METERS;
        sphereR = Math.max(extentMeters * RADIUS_FRACTION, 0.5);
      } else {
        sphereR = args.sphereRadiusMeters ?? 2;
      }
      const sphereRadii = new Cartesian3(sphereR, sphereR, sphereR);
      const volumeShape = circleShape(volumeR);

      // Suspend collection-change events during the batch so Cesium
      // processes the full set once at the end rather than per-add.
      // Without this, 200+ ellipsoid adds fire 200+ events, each
      // triggering listeners (vertical exaggeration, etc.) that
      // walk the full entity list — O(N^2) total.
      viewer.entities.suspendEvents();

      // Performance gate: Entity.ellipsoid creates a full 3D mesh
      // per point. Fine for 200–500 aggregated results, but the
      // no-analyte samples overview can have 10K+ rows and each
      // sphere is a geometry instance — way too slow. When the row
      // count exceeds the threshold, fall back to screen-space
      // Entity.point (hardware-accelerated, one draw call for all
      // points). The user gets 3D spheres on the analyte-selected
      // view (small N) and fast dots on the overview (large N).
      const SPHERE_THRESHOLD = 500;
      const forceScreenSpace = rows.length > SPHERE_THRESHOLD;

      // Create entities. Each one gets a stable ID prefixed with
      // layerId so we can clean it up unambiguously.
      //
      // Rendering decision tree (per row):
      //
      //  chemduck-location + depth interval → polylineVolume tube
      //    (borehole segment, fabricated vertical trajectory unless
      //    deviation survey data is available)
      //
      //  chemduck-location + no depth interval + altitude → ellipsoid
      //    (3D sphere for surface locations / shallow grab samples)
      //
      //  vector-feature (geoparquet point) → 2D screen-space point
      //    (terrain-clamped when altitude is missing)
      //
      //  chemduck-location + no altitude → 2D point fallback
      //    (shouldn't happen because chemduck SQL always computes
      //    an altitude, but safe to handle)
      for (const row of rows) {
        if (cancelled) break;
        const lon = Number(row.longitude);
        const lat = Number(row.latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

        const altRaw = row.altitude;
        const hasExplicitAlt =
          altRaw != null && Number.isFinite(Number(altRaw));
        const alt = hasExplicitAlt ? Number(altRaw) : 0;

        const surfaceElevRaw = row.surface_elev_m;
        const surfaceElev =
          surfaceElevRaw != null && Number.isFinite(Number(surfaceElevRaw))
            ? Number(surfaceElevRaw)
            : alt;

        const topDepthRaw = row.top_depth_m;
        const bottomDepthRaw = row.bottom_depth_m;
        const hasDepth =
          topDepthRaw != null &&
          bottomDepthRaw != null &&
          Number.isFinite(Number(topDepthRaw)) &&
          Number.isFinite(Number(bottomDepthRaw));

        const value = colorByCol ? row[colorByCol] : undefined;
        const color = colorFn(value);
        const rowId = String(row.location_id ?? '');
        const id = `${args.layerId}:${rowId}`;
        const label = String(row.label ?? rowId ?? args.layerId);

        try {
          let entity;

          // ── Screen-space fast path (large datasets, surface only) ─
          // When row count exceeds the threshold AND this row has no
          // depth interval, use Entity.point (single draw call,
          // handles 10K+ points without lag). Rows WITH depth
          // intervals always get polylineVolume regardless of count,
          // because borehole segments need 3D geometry to communicate
          // depth — a 2D screen-space dot at the surface is useless
          // for a subsurface sample.
          if (forceScreenSpace && !hasDepth) {
            entity = viewer.entities.add({
              id,
              name: label,
              position: Cartesian3.fromDegrees(lon, lat, alt),
              point: {
                pixelSize: 10,
                color,
                outlineColor: Color.WHITE,
                outlineWidth: 1,
                heightReference: hasExplicitAlt
                  ? HeightReference.NONE
                  : HeightReference.CLAMP_TO_GROUND,
              },
            });
            if (isChemduck) {
              setEntityMetadata(entity, {
                kind: 'chemduck-location',
                layerId: args.layerId,
                locationId: rowId,
                primitiveType: 'point',
                rowData: stripPositioningColumns(row),
              });
            } else {
              setEntityMetadata(entity, {
                kind: 'vector-feature',
                layerId: args.layerId,
                featureId: rowId,
                label,
                properties: stripPositioningColumns(row),
              });
            }
          }

          // ── polylineVolume (borehole segment) ──────────────────
          // Guard: the segment must have enough vertical separation
          // for Cesium to compute a direction normal. A zero- or
          // near-zero-length segment (top_depth ≈ bottom_depth)
          // produces identical positions → normalize(zero) → NaN →
          // crash in createPolylineVolumeGeometry. Fall back to
          // sphere for degenerate intervals.
          const MIN_SEGMENT_LENGTH_M = 0.1;
          if (!entity && isChemduck && hasDepth && renderMode !== 'sphere') {
            const topM = Number(topDepthRaw);
            const bottomM = Number(bottomDepthRaw);
            const segmentLength = Math.abs(bottomM - topM);

            if (segmentLength >= MIN_SEGMENT_LENGTH_M) {
              const trajectory = fabricateTrajectory(
                lon,
                lat,
                surfaceElev,
                topM,
                bottomM,
              );
              const positions = trajectory.map((p) =>
                Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
              );
              entity = viewer.entities.add({
                id,
                name: label,
                polylineVolume: {
                  positions,
                  shape: volumeShape,
                  material: color,
                },
              });
              setEntityMetadata(entity, {
                kind: 'chemduck-location',
                layerId: args.layerId,
                locationId: rowId,
                normalColor: color,
                primitiveType: 'polylineVolume',
                rowData: stripPositioningColumns(row),
              });
            }
            // Degenerate segment — fall through to the sphere path
          }

          // ── ellipsoid (3D sphere) ────────────────────────────
          if (!entity && isChemduck && hasExplicitAlt) {
            entity = viewer.entities.add({
              id,
              name: label,
              position: Cartesian3.fromDegrees(lon, lat, alt),
              ellipsoid: {
                radii: sphereRadii,
                material: color,
                stackPartitions: 8,
                slicePartitions: 8,
              },
            });
            setEntityMetadata(entity, {
              kind: 'chemduck-location',
              layerId: args.layerId,
              locationId: rowId,
              normalColor: color,
              primitiveType: 'ellipsoid',
              rowData: stripPositioningColumns(row),
            });

            // ── 2D point fallback ────────────────────────────────
          } else if (!entity) {
            entity = viewer.entities.add({
              id,
              name: label,
              position: Cartesian3.fromDegrees(lon, lat, alt),
              point: {
                pixelSize: 8,
                color,
                outlineColor: Color.WHITE,
                outlineWidth: 1,
                heightReference: hasExplicitAlt
                  ? HeightReference.NONE
                  : HeightReference.CLAMP_TO_GROUND,
              },
            });
            if (isChemduck) {
              setEntityMetadata(entity, {
                kind: 'chemduck-location',
                layerId: args.layerId,
                locationId: rowId,
                primitiveType: 'point',
              });
            } else {
              setEntityMetadata(entity, {
                kind: 'vector-feature',
                layerId: args.layerId,
                featureId: rowId,
                label,
                properties: stripPositioningColumns(row),
              });
            }
          }

          created.push({id});
        } catch (e) {
          // Duplicate id — skip silently.
        }
      }

      viewer.entities.resumeEvents();
    })();

    return () => {
      cancelled = true;
      setLayerBbox(args.layerId, null);
      if (!viewer || viewer.isDestroyed()) return;
      for (const e of created) {
        if (viewer.entities.getById(e.id)) {
          viewer.entities.removeById(e.id);
        }
      }
    };
  }, [
    viewer,
    connector,
    args.layerId,
    args.sqlQuery,
    args.visible,
    args.visSpecTable,
    args.entityKind,
    args.sampleRenderAs,
    args.sphereRadiusMeters,
    args.volumeRadiusMeters,
    visSpec,
    colorByCol,
  ]);
}
