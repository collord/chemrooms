/**
 * Out-of-band metadata attached to Cesium entities at creation time.
 *
 * Why not `entity.properties`?
 * Cesium's native Entity.properties wraps plain objects into a
 * PropertyBag (time-varying property infrastructure), which means
 * reading them back requires a JulianDate and the API is a bit
 * awkward for our "just store a blob of JS data per entity" use case.
 *
 * A WeakMap keyed on the Entity object gives us simpler semantics:
 *  - set at creation, read at click time — plain JS values in, plain
 *    JS values out.
 *  - auto-cleans when the Entity is garbage collected.
 *  - zero interference with Cesium's own property system (tileset
 *    features, DataSource-driven entities, etc. can still use
 *    entity.properties without collisions).
 *
 * The click handler in useLocationClick reads this map to decide
 * whether a click should become a chemduck-location selection (with
 * follow-up SQL queries) or a vector-feature selection (with the
 * attributes travelling inline).
 */

import type {Entity} from 'cesium';

export type EntityMetadata =
  | {
      kind: 'chemduck-location';
      /** Source layer id: 'locations', 'samples', 'personal:<hash>', etc. */
      layerId: string;
      /** `location_id` identifier from the chemduck schema. */
      locationId: string;
      /**
       * The entity's unselected material color. Stored so the
       * selection-highlight logic can revert after deselection.
       * Present on 3D primitives (sphere, polylineVolume); absent
       * on the legacy 2D point fallback (which doesn't participate
       * in the imperative restyle — it uses Cesium's screen-space
       * rendering that doesn't need material swaps).
       */
      normalColor?: import('cesium').Color;
      /** Which Cesium primitive this entity uses, for restyle dispatch. */
      primitiveType?: 'ellipsoid' | 'polylineVolume' | 'point';
    }
  | {
      kind: 'vector-feature';
      /** Source layer id, e.g. 'personal:<hash>'. */
      layerId: string;
      /** Per-feature id (the `location_id` column in the SQL). */
      featureId: string;
      /** Display label (the `label` column in the SQL). */
      label: string;
      /**
       * All attribute columns that came through the SQL, minus the
       * positioning columns (longitude/latitude/altitude/label).
       * These are what the Inspector renders as the attribute table.
       */
      properties: Record<string, unknown>;
      /**
       * If this entity is one we should restyle on selection change
       * (i.e., a polyline — either a standalone LineString entity
       * or a polygon outline ring), the default outline color and
       * width to revert to when this feature is not selected. Not
       * present for polygon fill entities (they don't participate
       * in selection highlighting — GIS convention highlights the
       * boundary, not the interior).
       */
      outlineStyle?: {
        normalColor: import('cesium').Color;
        normalWidth: number;
      };
    };

const entityMetadata = new WeakMap<Entity, EntityMetadata>();

export function setEntityMetadata(entity: Entity, meta: EntityMetadata): void {
  entityMetadata.set(entity, meta);
}

export function getEntityMetadata(entity: Entity): EntityMetadata | undefined {
  return entityMetadata.get(entity);
}

/**
 * Build the `properties` field for a vector-feature metadata entry
 * from a row, stripping the positioning columns that the renderer
 * already consumed. Exported because both the point and vector
 * hooks use the same stripping rule — keeping it here keeps the
 * "what counts as a property" decision in one place.
 */
const POSITIONING_COLUMN_NAMES = new Set([
  'location_id',
  'longitude',
  'latitude',
  'altitude',
  'label',
  'geom',
  // chemduck aggregate_results passes through these for the point
  // renderer's color pipeline; they're not user-visible attributes
  // in a vector-feature sense but also aren't positioning columns.
  // We keep them because they're meaningful for chemduck location
  // selections, and vector-feature selections never have them.
]);

export function stripPositioningColumns(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!POSITIONING_COLUMN_NAMES.has(key)) {
      out[key] = value;
    }
  }
  return out;
}
