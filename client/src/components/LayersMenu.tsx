/**
 * Hamburger-style layers menu with visibility toggles.
 *
 * Static layers:
 *  - Site Data (points from store/DuckDB)
 *  - Topography (Cesium world terrain)
 *
 * Dynamic layers: fetched from /tiles/manifest.json at startup —
 * one toggle per tileset subdirectory found on the server.
 */

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {Menu} from 'lucide-react';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {Cesium3DTileset} from 'cesium';

interface TilesetEntry {
  name: string;
  url: string;
}

const SERVER_BASE =
  import.meta.env.VITE_DATA_URL?.replace('/data', '') ?? 'http://localhost:8000';

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

  // Fetch manifest on mount
  useEffect(() => {
    fetch(`${SERVER_BASE}/tiles/manifest.json`)
      .then((r) => r.json())
      .then((data) => {
        const entries: TilesetEntry[] = data.tilesets ?? [];
        setTilesets(entries);
        setTilesetVisibility(
          Object.fromEntries(entries.map((t) => [t.name, false])),
        );
      })
      .catch(() => {/* server may not have any tilesets yet */});
  }, []);

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
          const fullUrl = `${SERVER_BASE}${entry.url}`;
          Cesium3DTileset.fromUrl(fullUrl)
            .then((ts) => {
              tilesetRefs.current[entry.name] = ts;
              viewer.scene.primitives.add(ts);
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
    [tilesetVisibility, viewer],
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
