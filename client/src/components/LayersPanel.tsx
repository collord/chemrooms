/**
 * Collapsible panel listing all personal (and eventually shared) layers.
 *
 * Renders nothing visible on the map yet — that's a separate piece of
 * work to wire LayerConfig → useChemroomsEntities. This component
 * provides the UI affordances:
 *
 *   - Show layer count in the header (always visible)
 *   - Click header to expand/collapse the list
 *   - Each layer row: visibility checkbox, name, delete button
 *   - Empty state when no layers are saved
 *
 * Personal layers come from chemrooms.personalLayers (hydrated from
 * localStorage at startup). Toggling/removing here also persists.
 */

import React, {useState} from 'react';
import {ChevronDown, ChevronRight, Layers, Trash2} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {
  removePersonalLayer,
  togglePersonalLayerVisibility,
} from '../layers/layerStorage';

export const LayersPanel: React.FC = () => {
  const personalLayers = useChemroomsStore(
    (s) => s.chemrooms.personalLayers,
  );
  const setPersonalLayers = useChemroomsStore(
    (s) => s.chemrooms.setPersonalLayers,
  );
  const [open, setOpen] = useState(true);

  const count = personalLayers.length;

  const handleToggleVisibility = (id: string) => {
    const updated = togglePersonalLayerVisibility(id);
    setPersonalLayers(updated);
  };

  const handleRemove = (id: string) => {
    const updated = removePersonalLayer(id);
    setPersonalLayers(updated);
  };

  return (
    <div className="rounded-md border border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Layers className="h-3.5 w-3.5" />
        <span className="font-semibold uppercase tracking-wide">
          Layers
        </span>
        <span className="ml-auto text-[10px] tabular-nums">
          {count > 0 ? `(${count})` : ''}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-3 py-2">
          {count === 0 ? (
            <div className="py-2 text-center text-[11px] italic text-muted-foreground/70">
              No saved layers — pick an analyte and click Freeze layer
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {personalLayers.map((layer) => (
                <li
                  key={layer.id}
                  className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={() => handleToggleVisibility(layer.id)}
                    className="accent-primary"
                  />
                  <span
                    className={
                      layer.visible
                        ? 'flex-1 truncate text-foreground'
                        : 'flex-1 truncate text-muted-foreground'
                    }
                    title={layer.description ?? layer.name}
                  >
                    {layer.name}
                  </span>
                  <button
                    onClick={() => handleRemove(layer.id)}
                    className="text-muted-foreground/50 transition-colors hover:text-red-500"
                    title="Delete layer"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
