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
import {Cartesian3, Color, HeightReference} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {makeColorFnForColumn} from '../vis/colormap';

export interface UseChemroomsEntitiesArgs {
  /** Stable string used to namespace entity IDs and clean them up. */
  layerId: string;
  /** SQL to run. Must produce columns: location_id, longitude, latitude, altitude, label. */
  sqlQuery: string | null;
  /** Vis spec table key to look up colorBy for. */
  visSpecTable: string;
  /** Whether the layer should render. */
  visible: boolean;
}

const FALLBACK_COLOR = Color.CYAN;

export function useChemroomsEntities(args: UseChemroomsEntitiesArgs) {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const connector = useStoreWithCesium((s) => s.db.connector);
  const visSpec = useChemroomsStore(
    (s) => s.chemrooms.visSpecs[args.visSpecTable],
  );
  const colorByCol = useChemroomsStore(
    (s) => s.chemrooms.colorBy[args.visSpecTable],
  );

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

      // Create entities. Each one gets a stable ID prefixed with layerId
      // so we can clean it up unambiguously.
      for (const row of rows) {
        if (cancelled) break;
        const lon = Number(row.longitude);
        const lat = Number(row.latitude);
        const altRaw = Number(row.altitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const alt = Number.isFinite(altRaw) ? altRaw : 0;

        const value = colorByCol ? row[colorByCol] : undefined;
        const color = colorFn(value);
        const rowId = String(row.location_id ?? '');
        const id = `${args.layerId}:${rowId}`;

        try {
          viewer.entities.add({
            id,
            name: String(row.label ?? rowId ?? args.layerId),
            position: Cartesian3.fromDegrees(lon, lat, alt),
            point: {
              pixelSize: 8,
              color,
              outlineColor: Color.WHITE,
              outlineWidth: 1,
              heightReference: HeightReference.NONE,
            },
          });
          created.push({id});
        } catch (e) {
          // Duplicate id — skip silently. Shouldn't happen in practice
          // because the cleanup function removes old entities first.
        }
      }
    })();

    return () => {
      cancelled = true;
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
    visSpec,
    colorByCol,
  ]);
}
