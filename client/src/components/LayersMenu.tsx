/**
 * Hamburger-style layers menu with visibility toggles.
 *
 * Static layers:
 *  - Site Data (points from store/DuckDB)
 *  - Topography (Cesium world terrain)
 *
 * Dynamic layers: fetched from <BASE_URL>tiles/manifest.json at startup —
 * one toggle per tileset under client/public/tiles/. The manifest is
 * generated at build time by scripts/build-tiles-manifest.mjs.
 *
 * This component also mirrors the cross-section clipping plane onto every
 * loaded 3D Tileset. Cesium's globe.clippingPlanes only clips terrain;
 * tilesets need their own clipping plane in their local coordinate frame.
 */

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {Menu} from 'lucide-react';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {
  Cartesian3,
  Cesium3DTileset,
  ClippingPlane,
  ClippingPlaneCollection,
  Matrix3,
  Matrix4,
} from 'cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';

interface TilesetEntry {
  name: string;
  url: string; // relative to BASE_URL
}

const BASE_URL = import.meta.env.BASE_URL; // e.g. "/" or "/chemrooms/"

/**
 * Compute the ECEF clipping plane (normal, distance) from two lon/lat
 * surface points — matches the math in CrossSectionToggle.applyClippingPlane.
 */
function planeFromPoints(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): {normal: Cartesian3; distance: number} {
  const p1 = Cartesian3.fromDegrees(lon1, lat1);
  const p2 = Cartesian3.fromDegrees(lon2, lat2);
  const dir = Cartesian3.subtract(p2, p1, new Cartesian3());
  const midpoint = Cartesian3.midpoint(p1, p2, new Cartesian3());
  const up = Cartesian3.normalize(midpoint, new Cartesian3());
  const normal = Cartesian3.cross(dir, up, new Cartesian3());
  Cartesian3.normalize(normal, normal);
  const distance = -Cartesian3.dot(normal, p1);
  return {normal, distance};
}

/**
 * Transform an ECEF plane (n_w · p + d_w = 0) into a tileset's local frame.
 *
 * Given the tileset's modelMatrix M = [R | t], a local point p_l maps to
 * world space as p_w = R*p_l + t. Substituting into the plane equation:
 *   n_w · (R*p_l + t) + d_w = 0
 *   (R^T n_w) · p_l + (n_w · t + d_w) = 0
 *
 * So local normal = R^T * n_w, local distance = d_w + n_w · t.
 */
function transformPlaneToLocal(
  worldNormal: Cartesian3,
  worldDistance: number,
  modelMatrix: Matrix4,
): {normal: Cartesian3; distance: number} {
  const rotation = Matrix4.getMatrix3(modelMatrix, new Matrix3());
  const rotationT = Matrix3.transpose(rotation, new Matrix3());
  const localNormal = Matrix3.multiplyByVector(
    rotationT,
    worldNormal,
    new Cartesian3(),
  );
  Cartesian3.normalize(localNormal, localNormal);

  const translation = Matrix4.getTranslation(modelMatrix, new Cartesian3());
  const localDistance = worldDistance + Cartesian3.dot(worldNormal, translation);

  return {normal: localNormal, distance: localDistance};
}

function applyClippingToTileset(
  tileset: Cesium3DTileset,
  worldNormal: Cartesian3 | null,
  worldDistance: number | null,
) {
  // Always start clean
  if (tileset.clippingPlanes) {
    tileset.clippingPlanes.removeAll();
  }

  if (worldNormal === null || worldDistance === null) return;

  const {normal, distance} = transformPlaneToLocal(
    worldNormal,
    worldDistance,
    tileset.modelMatrix,
  );

  if (!tileset.clippingPlanes) {
    tileset.clippingPlanes = new ClippingPlaneCollection({
      planes: [new ClippingPlane(normal, distance)],
      edgeWidth: 2.0,
    });
  } else {
    tileset.clippingPlanes.add(new ClippingPlane(normal, distance));
  }
}

export const LayersMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [siteDataVisible, setSiteDataVisible] = useState(true);
  const [topoVisible, setTopoVisible] = useState(true);
  const [tilesets, setTilesets] = useState<TilesetEntry[]>([]);
  const [tilesetVisibility, setTilesetVisibility] = useState<Record<string, boolean>>({});

  const menuRef = useRef<HTMLDivElement>(null);
  const tilesetRefs = useRef<Record<string, Cesium3DTileset>>({});

  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const layers = useStoreWithCesium((s) => s.cesium.config.layers);
  const toggleLayerVisibility = useStoreWithCesium(
    (s) => s.cesium.toggleLayerVisibility,
  );
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );

  // Fetch manifest on mount
  useEffect(() => {
    const url = `${BASE_URL}tiles/manifest.json`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => {
        const entries: TilesetEntry[] = data.tilesets ?? [];
        setTilesets(entries);
        setTilesetVisibility(
          Object.fromEntries(entries.map((t) => [t.name, false])),
        );
      })
      .catch((e) => console.warn('[LayersMenu] no tiles manifest:', e));
  }, []);

  // Re-apply clipping plane to all loaded tilesets when cross-section changes
  useEffect(() => {
    let worldNormal: Cartesian3 | null = null;
    let worldDistance: number | null = null;
    if (crossSectionPoints) {
      const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
      const plane = planeFromPoints(lon1, lat1, lon2, lat2);
      worldNormal = plane.normal;
      worldDistance = plane.distance;
    }
    for (const ts of Object.values(tilesetRefs.current)) {
      applyClippingToTileset(ts, worldNormal, worldDistance);
    }
  }, [crossSectionPoints]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Clean up tilesets on unmount
  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return;
      for (const ts of Object.values(tilesetRefs.current)) {
        viewer.scene.primitives.remove(ts);
      }
      tilesetRefs.current = {};
    };
  }, [viewer]);

  const toggleSiteData = useCallback(() => {
    const next = !siteDataVisible;
    setSiteDataVisible(next);
    for (const layer of layers) {
      if (layer.visible !== next) toggleLayerVisibility(layer.id);
    }
  }, [siteDataVisible, layers, toggleLayerVisibility]);

  const toggleTopo = useCallback(() => {
    const next = !topoVisible;
    setTopoVisible(next);
    if (viewer && !viewer.isDestroyed()) {
      viewer.scene.globe.show = next;
    }
  }, [topoVisible, viewer]);

  const toggleTileset = useCallback(
    (entry: TilesetEntry) => {
      if (!viewer || viewer.isDestroyed()) return;
      const next = !tilesetVisibility[entry.name];
      setTilesetVisibility((v) => ({...v, [entry.name]: next}));

      if (next) {
        if (!tilesetRefs.current[entry.name]) {
          const fullUrl = `${BASE_URL}${entry.url}`;
          Cesium3DTileset.fromUrl(fullUrl)
            .then((ts) => {
              tilesetRefs.current[entry.name] = ts;
              viewer.scene.primitives.add(ts);

              // Apply current clipping plane (if any) to this freshly loaded tileset
              if (crossSectionPoints) {
                const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
                const {normal, distance} = planeFromPoints(lon1, lat1, lon2, lat2);
                applyClippingToTileset(ts, normal, distance);
              }
              console.log(`[LocalTopo:${entry.name}] loaded`);
            })
            .catch((err) =>
              console.error(`[LocalTopo:${entry.name}] failed:`, err),
            );
        } else {
          tilesetRefs.current[entry.name].show = true;
        }
      } else {
        if (tilesetRefs.current[entry.name]) {
          tilesetRefs.current[entry.name].show = false;
        }
      }
    },
    [tilesetVisibility, viewer, crossSectionPoints],
  );

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
        title="Layers"
      >
        <Menu className="h-3.5 w-3.5" />
        <span>Layers</span>
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-48 rounded-md border border-border bg-background py-1 shadow-lg">
          {/* Static layers */}
          <LayerRow label="Site Data" checked={siteDataVisible} onChange={toggleSiteData} />
          <LayerRow label="Topography" checked={topoVisible} onChange={toggleTopo} />

          {/* Dynamic tileset layers */}
          {tilesets.length > 0 && (
            <>
              <div className="mx-3 my-1 border-t border-border" />
              {tilesets.map((entry) => (
                <LayerRow
                  key={entry.name}
                  label={entry.name}
                  checked={tilesetVisibility[entry.name] ?? false}
                  onChange={() => toggleTileset(entry)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const LayerRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: () => void;
}> = ({label, checked, onChange}) => (
  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted">
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="accent-primary"
    />
    <span className={checked ? 'text-foreground' : 'text-muted-foreground'}>
      {label}
    </span>
  </label>
);
