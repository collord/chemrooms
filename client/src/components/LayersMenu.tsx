/**
 * Hamburger-style layers menu with visibility toggles.
 *
 * Layers:
 *  - Site Data (points from store/DuckDB)
 *  - Topography (Cesium world terrain)
 *  - Local Topo (3D Tileset served from /tiles/)
 */

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {Menu} from 'lucide-react';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {Cesium3DTileset} from 'cesium';

interface LayerItem {
  id: string;
  label: string;
  defaultVisible: boolean;
}

const LAYERS: LayerItem[] = [
  {id: 'site-data', label: 'Site Data', defaultVisible: true},
  {id: 'topography', label: 'Topography', defaultVisible: true},
  {id: 'local-topo', label: 'Local Topo', defaultVisible: false},
];

const TILES_BASE_URL =
  import.meta.env.VITE_TILES_URL ?? 'http://localhost:8000/tiles';

export const LayersMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultVisible])),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const tilesetRef = useRef<Cesium3DTileset | null>(null);

  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const layers = useStoreWithCesium((s) => s.cesium.config.layers);
  const toggleLayerVisibility = useStoreWithCesium(
    (s) => s.cesium.toggleLayerVisibility,
  );

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

  // Clean up tileset on unmount
  useEffect(() => {
    return () => {
      if (tilesetRef.current && viewer && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(tilesetRef.current);
        tilesetRef.current = null;
      }
    };
  }, [viewer]);

  const toggle = useCallback(
    (id: string) => {
      const next = !visibility[id];
      setVisibility((v) => ({...v, [id]: next}));

      if (id === 'site-data') {
        // Toggle all DuckDB-sourced entity layers
        for (const layer of layers) {
          if (layer.visible !== next) {
            toggleLayerVisibility(layer.id);
          }
        }
      } else if (id === 'topography') {
        if (viewer && !viewer.isDestroyed()) {
          viewer.scene.globe.show = next;
        }
      } else if (id === 'local-topo') {
        if (!viewer || viewer.isDestroyed()) return;

        if (next) {
          // Load tileset if not already loaded
          if (!tilesetRef.current) {
            Cesium3DTileset.fromUrl(`${TILES_BASE_URL}/tileset.json`)
              .then((tileset) => {
                tilesetRef.current = tileset;
                viewer.scene.primitives.add(tileset);
                console.log('[LocalTopo] Tileset loaded', tileset);
              })
              .catch((err) => {
                console.error('[LocalTopo] Failed to load tileset:', err);
              });
          } else {
            tilesetRef.current.show = true;
          }
        } else {
          if (tilesetRef.current) {
            tilesetRef.current.show = false;
          }
        }
      }
    },
    [visibility, viewer, layers, toggleLayerVisibility],
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
          {LAYERS.map((layer) => (
            <label
              key={layer.id}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={visibility[layer.id] ?? layer.defaultVisible}
                onChange={() => toggle(layer.id)}
                className="accent-primary"
              />
              <span
                className={
                  visibility[layer.id]
                    ? 'text-foreground'
                    : 'text-muted-foreground'
                }
              >
                {layer.label}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
