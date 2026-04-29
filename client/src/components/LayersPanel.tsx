/**
 * Unified Layers panel — collapsible, always visible in the sidebar.
 *
 * Three sections, top to bottom:
 *
 *   1. Site context — base layers that establish the ground truth:
 *      - Topography (Cesium world terrain)
 *      - Local mesh tilesets (loaded from tiles/manifest.json)
 *
 *   2. Live recipe — the interactive view from the recipe sidebar:
 *      - Locations (cyan overview when no analyte)
 *      - Samples (cyan overview or per-result colored when analyte set)
 *
 *   3. Workspace — saved snapshots from the Freeze Layer button,
 *      plus any drag-dropped geoparquet files in this session.
 *      Each row has visibility checkbox + delete button.
 *
 * Replaces the old hamburger LayersMenu — there's now exactly one
 * place to manage all layer visibility.
 *
 * Side effects (tileset loading, clipping plane sync) are handled by
 * the useTilesetManager and useClippingPlaneSync hooks. This component
 * only owns the UI.
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  Download,
  Layers,
  Trash2,
  Upload,
} from 'lucide-react';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {Color} from 'cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {useTilesetManager} from '../hooks/useTilesetManager';
import {useClippingPlaneSync} from '../hooks/useClippingPlaneSync';
import {useWaybackImagery} from '../hooks/useWaybackImagery';
import {
  addPersonalLayer,
  exportLayerAsJson,
  importLayerFromFile,
  removePersonalLayer,
  togglePersonalLayerVisibility,
} from '../layers/layerStorage';
import {registerGeoparquetLayer} from '../layers/registerGeoparquetLayer';

export const LayersPanel: React.FC = () => {
  const [open, setOpen] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  // ── Site context ────────────────────────────────────────────────────
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const connector = useStoreWithCesium((s) => s.db.connector);
  const isDataAvailable = useStoreWithCesium(
    (s) => s.room.isDataAvailable,
  );
  const [topoVisible, setTopoVisible] = useState(true);
  const [topoWhiteBlend, setTopoWhiteBlend] = useState(0.3);
  const {tilesets, tilesetRefs, toggleTileset} = useTilesetManager();
  useClippingPlaneSync(tilesetRefs, tilesets.length);

  // ESRI Wayback (historical World Imagery snapshots).
  const wayback = useWaybackImagery();

  // Set globe base color to white once so reducing imagery alpha blends to white.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    viewer.scene.globe.baseColor = Color.WHITE;
  }, [viewer]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const layer = viewer.scene.globe.imageryLayers.get(0);
    if (layer) {
      layer.saturation = 1.0;
      layer.alpha = 1 - topoWhiteBlend;
    }
  }, [viewer, topoWhiteBlend]);

  const toggleTopo = useCallback(() => {
    const next = !topoVisible;
    setTopoVisible(next);
    if (viewer && !viewer.isDestroyed()) {
      viewer.scene.globe.show = next;
    }
  }, [topoVisible, viewer]);

  const toggleWayback = useCallback(() => {
    if (wayback.isActive) {
      wayback.clear();
    } else if (wayback.items.length > 0) {
      // Default to the most recent release on first activation.
      wayback.setActiveReleaseNum(wayback.items[0]!.releaseNum);
    }
  }, [wayback]);

  // ── Live recipe ─────────────────────────────────────────────────────
  const locationsVisible = useChemroomsStore(
    (s) => s.chemrooms.locationsVisible,
  );
  const setLocationsVisible = useChemroomsStore(
    (s) => s.chemrooms.setLocationsVisible,
  );
  const samplesVisible = useChemroomsStore((s) => s.chemrooms.samplesVisible);
  const setSamplesVisible = useChemroomsStore(
    (s) => s.chemrooms.setSamplesVisible,
  );
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );

  // ── Workspace ───────────────────────────────────────────────────────
  const personalLayers = useChemroomsStore(
    (s) => s.chemrooms.personalLayers,
  );
  const setPersonalLayers = useChemroomsStore(
    (s) => s.chemrooms.setPersonalLayers,
  );
  const bookmarkLayers = useChemroomsStore(
    (s) => s.chemrooms.bookmarkLayers,
  );
  const setBookmarkLayers = useChemroomsStore(
    (s) => s.chemrooms.setBookmarkLayers,
  );
  const toggleBookmarkLayer = useChemroomsStore(
    (s) => s.chemrooms.toggleBookmarkLayer,
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToggleFrozen = (id: string) => {
    const updated = togglePersonalLayerVisibility(id, personalLayers);
    setPersonalLayers(updated);
  };

  const handleRemoveFrozen = (id: string) => {
    const updated = removePersonalLayer(id, personalLayers);
    setPersonalLayers(updated);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    let lastResult = personalLayers;
    let skipped = 0;
    for (const file of Array.from(files)) {
      const layer = await importLayerFromFile(file);
      if (!layer) continue;
      const res = await addPersonalLayer(
        {...layer, origin: 'personal'},
        lastResult,
      );
      lastResult = res.layers;
      if (!res.added) skipped += 1;
    }
    setPersonalLayers(lastResult);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (skipped > 0) {
      console.log(`[layers] skipped ${skipped} duplicate layer(s) on import`);
    }
  };

  /**
   * Drag-and-drop ingest for spatial files. Currently routes any
   * .parquet / .geoparquet through registerGeoparquetLayer; future
   * formats (shapefile, gpkg, csv) would dispatch here based on
   * extension or sniffed magic bytes.
   *
   * Errors are surfaced as a small inline message so the user knows
   * something went wrong without having to check the console.
   */
  const handleFilesDropped = useCallback(
    async (files: FileList) => {
      // The connector object exists before DuckDB-WASM is actually
      // initialized — waiting on isDataAvailable ensures INSTALL
      // spatial and loadFile won't hit "duckdb is not initialized".
      if (!connector || !isDataAvailable) {
        setDropError('Database not ready yet — try again in a moment.');
        return;
      }
      setDropError(null);
      let lastResult = personalLayers;
      let added = 0;
      let skipped = 0;
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        if (!lower.endsWith('.parquet') && !lower.endsWith('.geoparquet')) {
          setDropError(
            `Unsupported format: ${file.name}. Drop a .parquet or .geoparquet file.`,
          );
          continue;
        }
        try {
          const {layer} = await registerGeoparquetLayer(connector, file);
          // Pass lastResult so each iteration sees the previous
          // iteration's ephemeral additions; otherwise dropping
          // three files in one gesture would only land the last one
          // in the slice.
          const res = await addPersonalLayer(layer, lastResult);
          lastResult = res.layers;
          if (res.added) added += 1;
          else skipped += 1;
        } catch (e) {
          console.error('[layers] geoparquet ingest failed:', e);
          setDropError(
            `Failed to load ${file.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (added > 0 || skipped > 0) {
        setPersonalLayers(lastResult);
      }
    },
    [connector, isDataAvailable, personalLayers, setPersonalLayers],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // preventDefault is required to make the drop zone actually accept files
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDragActive(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // currentTarget vs target: only deactivate if we're leaving the
    // drop zone itself, not just moving between children
    if (e.currentTarget === e.target) {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        void handleFilesDropped(files);
      }
    },
    [handleFilesDropped],
  );

  /**
   * Promote a bookmark layer into personal storage. We do this
   * imperatively in the handler so the localStorage write happens
   * with the correct merged list — promoteBookmarkLayer alone only
   * mutates the slice, not localStorage.
   */
  const handlePromoteBookmark = async (id: string) => {
    const layer = bookmarkLayers.find((l) => l.id === id);
    if (!layer) return;
    const promoted = {...layer, origin: 'personal' as const};
    const {layers: updatedPersonal} = await addPersonalLayer(
      promoted,
      personalLayers,
    );
    setPersonalLayers(updatedPersonal);
    setBookmarkLayers(bookmarkLayers.filter((l) => l.id !== id));
  };

  // ── Render ──────────────────────────────────────────────────────────
  const totalCount =
    1 + // topography always present
    1 + // wayback always counted (whether active or not)
    tilesets.length +
    2 + // locations + samples (live)
    personalLayers.length;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={
        dragActive
          ? 'rounded-md border-2 border-dashed border-primary bg-primary/10 transition-colors'
          : 'rounded-md border border-border transition-colors'
      }
    >
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
          ({totalCount})
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {/* ── Site context ───────────────────────────────────────── */}
          <SectionLabel>Site context</SectionLabel>
          <div className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50">
            <input
              type="checkbox"
              checked={topoVisible}
              onChange={toggleTopo}
              className="accent-primary"
            />
            <span className={topoVisible ? 'text-foreground' : 'text-muted-foreground'}>
              Topography
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={topoWhiteBlend}
              onChange={(e) => setTopoWhiteBlend(Number(e.target.value))}
              className="ml-auto w-16"
              title={`Fade to white: ${Math.round(topoWhiteBlend * 100)}%`}
            />
          </div>
          <LayerRow
            label="Wayback Imagery"
            checked={wayback.isActive}
            onChange={toggleWayback}
            note={wayback.items.length === 0 ? 'loading…' : undefined}
          />
          {wayback.isActive && wayback.items.length > 0 && (
            <div className="flex items-center gap-2 pl-6 text-[11px] text-muted-foreground">
              <span className="shrink-0">Release:</span>
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                value={wayback.activeReleaseNum ?? ''}
                onChange={(e) =>
                  wayback.setActiveReleaseNum(Number(e.target.value))
                }
              >
                {wayback.items.map((item) => (
                  <option key={item.releaseNum} value={item.releaseNum}>
                    {item.releaseDateLabel}
                  </option>
                ))}
              </select>
            </div>
          )}
          {tilesets.map((entry) => (
            <LayerRow
              key={entry.name}
              label={entry.name}
              checked={entry.visible}
              onChange={() => toggleTileset(entry.name)}
            />
          ))}

          {/* ── Live recipe ────────────────────────────────────────── */}
          <SectionLabel>Live recipe</SectionLabel>
          <LayerRow
            label="Locations"
            checked={locationsVisible}
            onChange={() => setLocationsVisible(!locationsVisible)}
            note={
              coloringAnalyte
                ? 'auto-hidden while analyte selected'
                : undefined
            }
          />
          <LayerRow
            label={coloringAnalyte ? 'Samples (aggregated)' : 'Samples'}
            checked={samplesVisible}
            onChange={() => setSamplesVisible(!samplesVisible)}
          />

          {/* ── Workspace ──────────────────────────────────────────── */}
          <SectionLabel>
            Workspace
            {personalLayers.length > 0 && (
              <span className="ml-1 text-[10px] tabular-nums opacity-60">
                ({personalLayers.length})
              </span>
            )}
          </SectionLabel>
          {dragActive && (
            <div className="rounded border border-dashed border-primary bg-primary/5 px-2 py-1 text-[11px] text-primary">
              Drop a .parquet / .geoparquet file to load it as a layer
            </div>
          )}
          {dropError && (
            <div className="rounded border border-red-400/50 bg-red-500/10 px-2 py-1 text-[11px] text-red-500">
              {dropError}
            </div>
          )}
          {personalLayers.length === 0 ? (
            <div className="px-1 py-1 text-[11px] italic text-muted-foreground/60">
              None — pick an analyte and click Freeze layer
            </div>
          ) : (
            personalLayers.map((layer) => (
              <div
                key={layer.id}
                className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={() => handleToggleFrozen(layer.id)}
                  className="accent-primary"
                />
                <span
                  className={
                    layer.visible
                      ? 'flex-1 truncate text-foreground'
                      : 'flex-1 truncate text-muted-foreground'
                  }
                  title={`${layer.description ?? layer.name}\n#${layer.id.slice(0, 8)}`}
                >
                  {layer.name}
                </span>
                <button
                  onClick={() => exportLayerAsJson(layer)}
                  className="text-muted-foreground/50 transition-colors hover:text-foreground"
                  title="Export layer as JSON file"
                >
                  <Download className="h-3 w-3" />
                </button>
                <button
                  onClick={() => handleRemoveFrozen(layer.id)}
                  className="text-muted-foreground/50 transition-colors hover:text-red-500"
                  title="Delete layer"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
          <div className="flex justify-end pt-1">
            <button
              onClick={handleImportClick}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Import a layer from a .layer.json file"
            >
              <Upload className="h-3 w-3" />
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              onChange={handleFileSelected}
              className="hidden"
            />
          </div>

          {/* ── From bookmark ──────────────────────────────────────── */}
          {bookmarkLayers.length > 0 && (
            <>
              <SectionLabel>
                From bookmark
                <span className="ml-1 text-[10px] tabular-nums opacity-60">
                  ({bookmarkLayers.length})
                </span>
              </SectionLabel>
              <div className="px-1 py-0.5 text-[10px] italic text-muted-foreground/60">
                Loaded from URL — not saved to your layers
              </div>
              {bookmarkLayers.map((layer) => (
                <div
                  key={layer.id}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={() => toggleBookmarkLayer(layer.id)}
                    className="accent-primary"
                  />
                  <span
                    className={
                      layer.visible
                        ? 'flex-1 truncate text-foreground'
                        : 'flex-1 truncate text-muted-foreground'
                    }
                    title={`${layer.description ?? layer.name}\n#${layer.id.slice(0, 8)}`}
                  >
                    {layer.name}
                  </span>
                  <button
                    onClick={() => handlePromoteBookmark(layer.id)}
                    className="text-muted-foreground/50 transition-colors hover:text-foreground"
                    title="Save this layer to your personal layers"
                  >
                    <BookmarkPlus className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────

const SectionLabel: React.FC<React.PropsWithChildren> = ({children}) => (
  <div className="mt-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
    {children}
  </div>
);

const LayerRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: () => void;
  note?: string;
}> = ({label, checked, onChange, note}) => (
  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50">
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="accent-primary"
    />
    <span
      className={
        checked ? 'flex-1 text-foreground' : 'flex-1 text-muted-foreground'
      }
    >
      {label}
    </span>
    {note && (
      <span className="text-[10px] italic text-muted-foreground/50">
        {note}
      </span>
    )}
  </label>
);
