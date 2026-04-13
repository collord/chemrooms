/**
 * Imperative Cesium entity rendering for vector (polyline / polygon)
 * geoparquet layers.
 *
 * Parallel to useChemroomsEntities (which handles points) — same
 * lifecycle shape, different primitives. Each row in the query
 * result carries a `geom` column with a GeoJSON string, plus the
 * same `location_id`, `label`, and passthrough properties contract.
 * The hook parses the GeoJSON, explodes MultiLineString /
 * MultiPolygon into one Cesium entity per component, and uses
 * Cesium's clampToGround / heightReference to let the GPU handle
 * the terrain-following subdivision.
 *
 * ## drapeMode resolution
 *
 * The caller passes a pre-resolved drape mode (`'drape'` or
 * `'absolute'`) — the `'auto'` decision happens upstream via
 * resolveDrapeMode. 'drape' means clampToGround: true (polylines)
 * or heightReference: CLAMP_TO_GROUND (polygons). 'absolute' uses
 * the positions as-given.
 *
 * ## What it does NOT do yet
 *
 * - **Per-row colorBy.** v1 uses a single fallback color (cyan).
 *   The vis-spec / colorBy machinery from the point path could be
 *   lifted over but it's a separate chunk.
 * - **Interior rings (polygon holes).** The geoJsonToVectorPieces
 *   helper captures them but the Cesium entity construction here
 *   only uses the outer ring. Adding holes is one more
 *   Cartesian3.fromDegreesArray call and a `holes:` field on the
 *   polygon entity.
 * - **Per-feature click handlers.** Clicks hit the entity via
 *   Cesium's pick API already; wiring that into the attributes
 *   panel is its own chunk.
 */

import {useEffect} from 'react';
import {
  Cartesian3,
  Color,
  HeightReference,
  PolygonHierarchy,
} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {geoJsonToVectorPieces, type ResolvedDrapeMode} from '../layers/vectorGeometry';

export interface UseChemroomsVectorEntitiesArgs {
  /** Stable string used to namespace entity IDs and clean them up. */
  layerId: string;
  /** SQL to run. Must produce columns: location_id, label, geom (GeoJSON string). */
  sqlQuery: string | null;
  /** Whether the layer should render. */
  visible: boolean;
  /** Resolved drape decision from resolveDrapeMode (upstream). */
  drapeMode: ResolvedDrapeMode;
}

const FALLBACK_COLOR = Color.CYAN.withAlpha(0.6);
const FALLBACK_OUTLINE = Color.CYAN;

export function useChemroomsVectorEntities(
  args: UseChemroomsVectorEntitiesArgs,
) {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const connector = useStoreWithCesium((s) => s.db.connector);

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
    const created: string[] = [];

    (async () => {
      let rows: Array<Record<string, unknown>> = [];
      try {
        const result = await connector.query(args.sqlQuery!);
        rows = result.toArray() as Array<Record<string, unknown>>;
      } catch (e) {
        console.error(`[${args.layerId}] vector query failed:`, e);
        return;
      }
      if (cancelled || rows.length === 0) return;

      for (const row of rows) {
        if (cancelled) break;

        const geomJson = row.geom;
        if (typeof geomJson !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(geomJson);
        } catch {
          continue;
        }
        const pieces = geoJsonToVectorPieces(parsed);
        if (pieces.length === 0) continue;

        const rowId = String(row.location_id ?? '');
        const label = String(row.label ?? rowId ?? args.layerId);

        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]!;
          const id = `${args.layerId}:${rowId}:${i}`;
          try {
            if (piece.kind === 'polyline') {
              const positions = positionsFromFlat(
                piece.positions,
                args.drapeMode,
              );
              if (!positions || positions.length < 2) continue;
              viewer.entities.add({
                id,
                name: label,
                polyline: {
                  positions,
                  width: 3,
                  material: FALLBACK_OUTLINE,
                  clampToGround: args.drapeMode === 'drape',
                },
              });
              created.push(id);
            } else if (piece.kind === 'polygon') {
              const outer = positionsFromFlat(piece.outer, args.drapeMode);
              if (!outer || outer.length < 3) continue;
              const holes = piece.holes
                .map((h) => positionsFromFlat(h, args.drapeMode))
                .filter(
                  (h): h is Cartesian3[] => h !== null && h.length >= 3,
                )
                .map((h) => new PolygonHierarchy(h));
              viewer.entities.add({
                id,
                name: label,
                polygon: {
                  hierarchy: new PolygonHierarchy(outer, holes),
                  material: FALLBACK_COLOR,
                  outline: true,
                  outlineColor: FALLBACK_OUTLINE,
                  heightReference:
                    args.drapeMode === 'drape'
                      ? HeightReference.CLAMP_TO_GROUND
                      : HeightReference.NONE,
                },
              });
              created.push(id);
            } else if (piece.kind === 'point') {
              // Edge case: a Point geometry that happened to come
              // through the vector renderer (geometryType !== 'point'
              // but the data contains a Point). Render as a simple
              // Cesium point so we don't silently drop it.
              const [lon, lat, h] = piece.coord;
              const position = Cartesian3.fromDegrees(lon, lat, h ?? 0);
              viewer.entities.add({
                id,
                name: label,
                position,
                point: {
                  pixelSize: 8,
                  color: FALLBACK_OUTLINE,
                  outlineColor: Color.WHITE,
                  outlineWidth: 1,
                  heightReference:
                    args.drapeMode === 'drape' && h === undefined
                      ? HeightReference.CLAMP_TO_GROUND
                      : HeightReference.NONE,
                },
              });
              created.push(id);
            }
          } catch (e) {
            // Duplicate id — skip silently. Shouldn't happen in practice
            // because the cleanup function removes old entities first.
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      if (!viewer || viewer.isDestroyed()) return;
      for (const id of created) {
        if (viewer.entities.getById(id)) {
          viewer.entities.removeById(id);
        }
      }
    };
  }, [
    viewer,
    connector,
    args.layerId,
    args.sqlQuery,
    args.visible,
    args.drapeMode,
  ]);
}

/**
 * Build Cesium Cartesian3[] from a flat coordinate array, picking
 * between fromDegreesArray (2D) and fromDegreesArrayHeights (3D)
 * based on array length. Returns null if the array shape is
 * malformed.
 *
 * For drape mode we pass the 2D form even if heights are present
 * in the data, because clampToGround ignores the height anyway and
 * passing the shorter array is cheaper and less confusing.
 */
function positionsFromFlat(
  flat: number[],
  drapeMode: ResolvedDrapeMode,
): Cartesian3[] | null {
  if (flat.length === 0) return null;

  // If drape mode, strip heights: clamp-to-ground ignores them.
  if (drapeMode === 'drape') {
    if (flat.length % 3 === 0 && flat.length % 2 !== 0) {
      // Must be 3D; strip the height triples.
      const twoD: number[] = [];
      for (let i = 0; i < flat.length; i += 3) {
        twoD.push(flat[i]!, flat[i + 1]!);
      }
      return Cartesian3.fromDegreesArray(twoD);
    }
    return Cartesian3.fromDegreesArray(flat);
  }

  // Absolute mode: use whatever form the flat array has.
  if (flat.length % 3 === 0 && flat.length % 2 !== 0) {
    return Cartesian3.fromDegreesArrayHeights(flat);
  }
  return Cartesian3.fromDegreesArray(flat);
}
