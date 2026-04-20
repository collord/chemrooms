/**
 * Cesium rendering for chemrooms sample/location layers.
 *
 * Uses the Primitive API for 3D geometry (spheres + borehole tubes)
 * and Entity API only for the screen-space point fallback on large
 * datasets. The Primitive path batches all geometry instances into
 * one draw call per shape type, with per-instance color via
 * ColorGeometryInstanceAttribute.
 *
 * Performance profile:
 *   - 1000 spheres: one Primitive, one draw call, geometry built
 *     on a web worker (asynchronous: true)
 *   - 1000 tubes: one Primitive, one draw call, same
 *   - 10K+ surface points: Entity.point fallback (hardware-
 *     accelerated screen-space circles)
 *
 * Click handling: scene.pick() returns {id, primitive} for
 * Primitive instances. The id is the string we set on
 * GeometryInstance, which maps to metadata in the module-level
 * primitiveMetadata Map. The click handler in useLocationClick
 * checks both Entity (WeakMap) and Primitive (Map) paths.
 */

import {useEffect, useRef} from 'react';
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  EllipsoidGeometry,
  GeometryInstance,
  HeightReference,
  PerInstanceColorAppearance,
  PolylineColorAppearance,
  PolylineGeometry,
  PolylineVolumeGeometry,
  Primitive,
  Transforms,
} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {makeColorFnForColumn} from '../vis/colormap';
import {
  clearPrimitiveMetadataForLayer,
  setEntityMetadata,
  setPrimitiveMetadata,
  stripPositioningColumns,
} from '../layers/entityMetadata';
import {fabricateTrajectory} from '../layers/desurvey';
import {BboxAccumulator, setLayerBbox} from '../layers/layerBbox';

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
  layerId: string;
  sqlQuery: string | null;
  visSpecTable: string;
  visible: boolean;
  colorByOverride?: string | null;
  entityKind?: 'chemduck-location' | 'vector-feature';
  sampleRenderAs?: 'auto' | 'sphere' | 'volume';
  sphereRadiusMeters?: number;
  volumeRadiusMeters?: number;
}

const FALLBACK_COLOR = Color.CYAN;
const SPHERE_THRESHOLD = 500;
/**
 * Above this many depth-interval rows, fall back to simple colored
 * lines (PolylineGeometry) instead of filled tubes. The Primitive
 * API handles thousands of tubes fine geometrically — the real
 * constraint is the async geometry compilation time. 50K is a
 * generous threshold; most environmental/minerals datasets are
 * well under this.
 */
const TUBE_THRESHOLD = 50_000;

/** Debounce delay for the entity creation effect. Selecting an
 * analyte cascades multiple state changes (analyte, colorBy, etc.)
 * that each trigger a re-render. Without debouncing, the effect
 * runs N times in rapid succession, each time destroying the
 * previous Primitive mid-compilation and starting a new 5000-tube
 * compile — the old worker gets killed, the new one starts, repeat.
 * A 300ms debounce lets the state settle before we do the heavy work. */
const EFFECT_DEBOUNCE_MS = 300;
const MIN_SEGMENT_LENGTH_M = 0.1;

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

  // Track primitives for cleanup
  const primitivesRef = useRef<Primitive[]>([]);
  const entityIdsRef = useRef<string[]>([]);

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
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Debounce: wait for deps to stabilize before doing the heavy
    // geometry work. Without this, analyte selection triggers 3–4
    // rapid re-runs that each destroy-and-recreate the Primitive.
    debounceTimer = setTimeout(() => {
    debounceTimer = null;

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

      // ── First pass: bbox ──────────────────────────────────────
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

      // ── Color function ────────────────────────────────────────
      let colorFn: (val: unknown) => Color = () => FALLBACK_COLOR;
      const colSpec =
        visSpec && colorByCol ? visSpec.columns[colorByCol] : undefined;
      if (colSpec && colorByCol) {
        if (colSpec.color.type === 'sequential') {
          const vals = rows
            .map((r) => Number(r[colorByCol]))
            .filter((v) => Number.isFinite(v));
          const domain: [number, number] | undefined =
            vals.length > 0
              ? [Math.min(...vals), Math.max(...vals)]
              : undefined;
          colorFn = makeColorFnForColumn(colSpec, domain);
        } else if (colSpec.color.type === 'categorical') {
          const seen = new Set<string>();
          for (const r of rows) {
            const v = r[colorByCol];
            if (v != null) seen.add(String(v));
          }
          const cats = Array.from(seen).sort();
          colorFn = makeColorFnForColumn(colSpec, undefined, cats);
        }
      }

      // ── Precompute rendering params ───────────────────────────
      const isChemduck =
        (args.entityKind ?? 'chemduck-location') === 'chemduck-location';
      const renderMode = args.sampleRenderAs ?? 'auto';

      // The "Diameter" slider value drives both sphere size AND
      // tube/line size. Internally we treat it as a diameter —
      // sphere radius = value / 2, tube cross-section radius =
      // value / 2, line width in pixels ≈ value (clamped).
      const DEG_TO_METERS = 111_000;
      const RADIUS_FRACTION = 0.01;
      let diameter: number;
      if (layerBbox) {
        const extentDeg = Math.max(
          layerBbox.east - layerBbox.west,
          layerBbox.north - layerBbox.south,
        );
        diameter = Math.max(extentDeg * DEG_TO_METERS * RADIUS_FRACTION, 1);
      } else {
        diameter = args.sphereRadiusMeters ?? 2;
      }
      const sphereR = diameter / 2;
      // Tube cross-section uses the same diameter as spheres — the
      // user wants visible cylinders at overview zoom for sparse
      // boreholes scattered over large distances.
      const volumeR = diameter / 2;
      const lineWidth = Math.max(2, Math.min(20, diameter));

      const forceScreenSpace = rows.length > SPHERE_THRESHOLD;

      // Pre-count depth rows to decide tube vs line rendering.
      let depthRowCount = 0;
      for (const row of rows) {
        if (row.top_depth_m != null && row.bottom_depth_m != null) {
          depthRowCount++;
        }
      }
      const useSimpleLines = depthRowCount > TUBE_THRESHOLD;
      const volumeShape = circleShape(volumeR);
      const vertexFormat = PerInstanceColorAppearance.VERTEX_FORMAT;

      // ── Second pass: build instances ──────────────────────────
      const sphereInstances: GeometryInstance[] = [];
      const tubeInstances: GeometryInstance[] = [];
      const lineInstances: GeometryInstance[] = [];
      const pointEntityIds: string[] = [];

      // Batch Entity.point additions when needed
      if (forceScreenSpace || !isChemduck) {
        viewer.entities.suspendEvents();
      }

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

        const chemduckMeta = {
          kind: 'chemduck-location' as const,
          layerId: args.layerId,
          locationId: rowId,
          normalColor: color,
          rowData: stripPositioningColumns(row),
        };

        // ── Screen-space fallback (large surface datasets) ──────
        if ((forceScreenSpace && !hasDepth) || !isChemduck) {
          try {
            const entity = viewer.entities.add({
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
                ...chemduckMeta,
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
            pointEntityIds.push(id);
          } catch {
            // Duplicate id
          }
          continue;
        }

        // ── Borehole segment (tube or line) ──────────────────────
        if (hasDepth && renderMode !== 'sphere') {
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
            try {
              if (useSimpleLines) {
                // Simple colored line — cheap, handles 5K+ segments
                lineInstances.push(
                  new GeometryInstance({
                    geometry: new PolylineGeometry({
                      positions,
                      width: lineWidth,
                      vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
                    }),
                    attributes: {
                      color: ColorGeometryInstanceAttribute.fromColor(color),
                    },
                    id,
                  }),
                );
              } else {
                // Filled tube — 6-sided cross-section, for ≤500 segments
                tubeInstances.push(
                  new GeometryInstance({
                    geometry: new PolylineVolumeGeometry({
                      polylinePositions: positions,
                      shapePositions: volumeShape,
                      vertexFormat,
                    }),
                    attributes: {
                      color: ColorGeometryInstanceAttribute.fromColor(color),
                    },
                    id,
                  }),
                );
              }
              setPrimitiveMetadata(id, {
                ...chemduckMeta,
                primitiveType: 'polylineVolume',
              });
              continue;
            } catch {
              // Degenerate geometry — fall through to sphere
            }
          }
          // Degenerate segment — fall through to sphere
        }

        // ── Ellipsoid sphere ────────────────────────────────────
        if (hasExplicitAlt) {
          const position = Cartesian3.fromDegrees(lon, lat, alt);
          sphereInstances.push(
            new GeometryInstance({
              geometry: new EllipsoidGeometry({
                radii: new Cartesian3(sphereR, sphereR, sphereR),
                stackPartitions: 8,
                slicePartitions: 8,
                vertexFormat,
              }),
              modelMatrix: Transforms.eastNorthUpToFixedFrame(position),
              attributes: {
                color: ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
          );
          setPrimitiveMetadata(id, {
            ...chemduckMeta,
            primitiveType: 'ellipsoid',
          });
        }
      }

      if (forceScreenSpace || !isChemduck) {
        viewer.entities.resumeEvents();
      }

      console.log(
        `[${args.layerId}] rendering: ${sphereInstances.length} spheres, ` +
          `${tubeInstances.length} tubes, ${lineInstances.length} lines, ` +
          `${pointEntityIds.length} points ` +
          `(${rows.length} rows total, forceScreenSpace=${forceScreenSpace})`,
      );

      // ── Build Primitives ──────────────────────────────────────
      const newPrimitives: Primitive[] = [];

      if (sphereInstances.length > 0 && !cancelled) {
        const spherePrimitive = new Primitive({
          geometryInstances: sphereInstances,
          appearance: new PerInstanceColorAppearance({
            closed: true,
            translucent: false,
          }),
          asynchronous: true,
        });
        viewer.scene.primitives.add(spherePrimitive);
        newPrimitives.push(spherePrimitive);
      }

      if (tubeInstances.length > 0 && !cancelled) {
        const tubePrimitive = new Primitive({
          geometryInstances: tubeInstances,
          appearance: new PerInstanceColorAppearance({
            closed: true,
            translucent: false,
          }),
          asynchronous: true,
        });
        viewer.scene.primitives.add(tubePrimitive);
        newPrimitives.push(tubePrimitive);
      }

      if (lineInstances.length > 0 && !cancelled) {
        const linePrimitive = new Primitive({
          geometryInstances: lineInstances,
          appearance: new PolylineColorAppearance(),
          asynchronous: true,
        });
        viewer.scene.primitives.add(linePrimitive);
        newPrimitives.push(linePrimitive);
      }

      primitivesRef.current = newPrimitives;
      entityIdsRef.current = pointEntityIds;
    })();

    }, EFFECT_DEBOUNCE_MS); // end debounce timer

    return () => {
      cancelled = true;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      setLayerBbox(args.layerId, null);
      clearPrimitiveMetadataForLayer(args.layerId);

      if (!viewer || viewer.isDestroyed()) return;

      // Remove primitives. Wrapped in try/catch because the
      // cleanup can race with Cesium's render loop — if the
      // primitive is mid-render when React's effect cleanup
      // fires (e.g., cross-section toggle causes a re-render),
      // remove() destroys the primitive and the renderer
      // crashes with "This object was destroyed." The catch
      // swallows the race; the primitive will be GC'd anyway.
      for (const p of primitivesRef.current) {
        try {
          if (!p.isDestroyed()) {
            viewer.scene.primitives.remove(p);
          }
        } catch {
          // Already destroyed or mid-render — safe to ignore
        }
      }
      primitivesRef.current = [];

      // Remove Entity.point fallbacks
      for (const id of entityIdsRef.current) {
        try {
          if (viewer.entities.getById(id)) {
            viewer.entities.removeById(id);
          }
        } catch {
          // Same race protection
        }
      }
      entityIdsRef.current = [];
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
