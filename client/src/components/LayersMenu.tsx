/**
 * Hamburger-style layers menu with visibility toggles.
 *
 * Layers:
 *  - Site Data (points from store/DuckDB)
 *  - Topography (Cesium world terrain)
 *  - Local Topo (placeholder for user-provided mesh)
 */

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {Menu} from 'lucide-react';
import {useStoreWithCesium} from '@sqlrooms/cesium';

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

export const LayersMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultVisible])),
  );
  const menuRef = useRef<HTMLDivElement>(null);

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
        // Placeholder — will toggle local mesh tileset when available
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
              {layer.id === 'local-topo' && (
                <span className="ml-auto text-[10px] text-muted-foreground/50">
                  —
                </span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
