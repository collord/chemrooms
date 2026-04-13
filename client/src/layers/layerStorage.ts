/**
 * Layer persistence — read/write layer configs to localStorage
 * and load shared layers from the deployment's static files.
 *
 * Two tiers:
 *
 * **Shared layers** — JSON files under `<BASE_URL>layers/<id>.json`,
 * discovered via `layers/manifest.json`. Read-only from the client.
 * Authored by the data team and deployed alongside the parquet data.
 *
 * **Personal layers** — stored in the browser's localStorage under
 * the key `chemrooms:layers`. Read-write from the client. Created
 * interactively via the "Freeze layer" action in the sidebar.
 *
 * Both tiers produce the same `LayerConfig` shape. The `origin` field
 * distinguishes them so the UI can render them differently (e.g.,
 * personal layers get a delete button, shared layers don't).
 */

import {
  parseLayerConfig,
  type LayerConfig,
  type LayerManifest,
} from './layerSchema';
import {computeLayerHash, isHashedId} from './layerHash';

/**
 * A layer is *ephemeral* when its data source bytes can't be
 * reloaded from anywhere the browser can reach on a future page
 * load. Concretely: a file the user dragged in has no re-fetchable
 * URL, so the layer config is useless without the original File.
 *
 * We mark these by giving them a `session:` (or legacy `file://`)
 * URL scheme in registerGeoparquetLayer. isEphemeralLayer checks
 * the scheme and tells storage not to persist, and
 * migratePersonalLayers strips any that somehow made it to
 * localStorage (e.g., from an earlier version of this code that
 * didn't know about the distinction).
 */
export function isEphemeralLayer(layer: LayerConfig): boolean {
  if (layer.dataSource.type !== 'geoparquet') return false;
  const url = layer.dataSource.url;
  return url.startsWith('session:') || url.startsWith('file://');
}

const LOCAL_STORAGE_KEY = 'chemrooms:layers';
const BASE_URL = import.meta.env.BASE_URL;

// ---------------------------------------------------------------------------
// Shared layers (static files)
// ---------------------------------------------------------------------------

/**
 * Fetch the shared-layer manifest and load each referenced config.
 * Returns [] if the manifest doesn't exist or is empty.
 */
export async function loadSharedLayers(): Promise<LayerConfig[]> {
  try {
    const resp = await fetch(`${BASE_URL}layers/manifest.json`);
    if (!resp.ok) return [];
    const manifest: LayerManifest = await resp.json();

    const results = await Promise.all(
      manifest.layers.map(async (entry) => {
        try {
          const r = await fetch(`${BASE_URL}${entry.url}`);
          if (!r.ok) return null;
          const raw = await r.json();
          const config = parseLayerConfig(raw);
          if (config) config.origin = 'shared';
          return config;
        } catch {
          return null;
        }
      }),
    );
    return results.filter((c): c is LayerConfig => c !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Personal layers (localStorage)
// ---------------------------------------------------------------------------

/** Read all personal layers from localStorage. */
export function loadPersonalLayers(): LayerConfig[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((item: unknown) => parseLayerConfig(item))
      .filter((c): c is LayerConfig => c !== null)
      .map((c) => ({...c, origin: 'personal' as const}));
  } catch {
    return [];
  }
}

/** Save all personal layers to localStorage. */
export function savePersonalLayers(layers: LayerConfig[]): void {
  try {
    const personal = layers.filter((l) => l.origin === 'personal');
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(personal));
  } catch (e) {
    console.warn('[layers] failed to save to localStorage:', e);
  }
}

/**
 * Add a personal layer and persist. Rehashes the layer's id from
 * its content so imported/promoted layers always get a canonical
 * id, and dedupes against existing layers with the same hash.
 *
 * `currentList` is the caller's view of what's in the slice right
 * now. It defaults to loadPersonalLayers() for backward
 * compatibility, but callers in a context where the slice may
 * contain ephemeral layers (e.g., the LayersPanel drop handler)
 * MUST pass the slice state so ephemeral entries are preserved
 * across adds — they're not in localStorage, so a fresh
 * loadPersonalLayers() wouldn't see them.
 *
 * If the new layer is ephemeral (dropped file, `session:` URL), it
 * is NOT written to localStorage — it will live in the in-memory
 * slice for this session only. Ephemeral entries already in
 * `currentList` are also filtered out of the localStorage write,
 * so persisting a chemduck layer doesn't accidentally promote an
 * ephemeral neighbor.
 *
 * If a layer with the same content hash already exists, this is a
 * no-op — `currentList` is returned unchanged.
 */
export async function addPersonalLayer(
  layer: LayerConfig,
  currentList: LayerConfig[] = loadPersonalLayers(),
): Promise<{
  layers: LayerConfig[];
  added: boolean;
  id: string;
  /** True when the layer was written to localStorage. */
  persisted: boolean;
}> {
  const id = await computeLayerHash(layer);
  if (currentList.some((l) => l.id === id)) {
    return {layers: currentList, added: false, id, persisted: false};
  }
  const updated = [
    ...currentList,
    {...layer, id, origin: 'personal' as const},
  ];
  if (isEphemeralLayer(layer)) {
    // Session-only: don't write to localStorage. The returned
    // `updated` list still includes the new layer so the slice
    // can render it for this session.
    return {layers: updated, added: true, id, persisted: false};
  }
  // Persist only the non-ephemeral portion — any ephemeral layers
  // already in currentList stay in the slice but not on disk.
  savePersonalLayers(updated.filter((l) => !isEphemeralLayer(l)));
  return {layers: updated, added: true, id, persisted: true};
}

/**
 * One-time migration for personal layers: rehash any entries whose
 * id doesn't match their content (legacy UUID-based ids, or layers
 * that were tampered with), and strip any ephemeral entries that
 * should never have been persisted (dropped-file geoparquet layers
 * from a prior version of addPersonalLayer that didn't know about
 * the distinction). Dedupes in case two legacy layers collapse to
 * the same hash. Persists the result.
 */
export async function migratePersonalLayers(): Promise<LayerConfig[]> {
  const existing = loadPersonalLayers();
  if (existing.length === 0) return existing;

  const seen = new Set<string>();
  const migrated: LayerConfig[] = [];
  let changed = false;
  let droppedEphemeral = 0;

  for (const layer of existing) {
    if (isEphemeralLayer(layer)) {
      // Can't rehydrate — the original File is gone. Drop it
      // silently and let the user re-drag if they still want it.
      changed = true;
      droppedEphemeral += 1;
      continue;
    }

    const ok = await isHashedId(layer);
    const id = ok ? layer.id : await computeLayerHash(layer);
    if (!ok) changed = true;
    if (seen.has(id)) {
      changed = true;
      continue;
    }
    seen.add(id);
    migrated.push(ok ? layer : {...layer, id});
  }

  if (droppedEphemeral > 0) {
    console.log(
      `[layers] dropped ${droppedEphemeral} ephemeral layer(s) from localStorage — ` +
        'dragged-in files can\'t be restored across page reloads.',
    );
  }
  if (changed) savePersonalLayers(migrated);
  return migrated;
}

/**
 * Remove a personal layer by id and persist.
 *
 * `currentList` is the caller's view of the slice (defaults to
 * localStorage-only, for backward compatibility). Callers whose
 * slice may contain ephemeral layers MUST pass their slice state,
 * otherwise the returned list won't include the ephemerals and
 * `setPersonalLayers(returned)` will wipe them. Ephemerals are
 * filtered out of the localStorage write so they never accidentally
 * get promoted.
 */
export function removePersonalLayer(
  id: string,
  currentList: LayerConfig[] = loadPersonalLayers(),
): LayerConfig[] {
  const updated = currentList.filter((l) => l.id !== id);
  savePersonalLayers(updated.filter((l) => !isEphemeralLayer(l)));
  return updated;
}

/**
 * Update a personal layer's visibility and persist. Same
 * currentList contract as removePersonalLayer — callers with
 * ephemeral layers in the slice must pass the slice state.
 */
export function togglePersonalLayerVisibility(
  id: string,
  currentList: LayerConfig[] = loadPersonalLayers(),
): LayerConfig[] {
  const updated = currentList.map((l) =>
    l.id === id ? {...l, visible: !l.visible} : l,
  );
  savePersonalLayers(updated.filter((l) => !isEphemeralLayer(l)));
  return updated;
}

// ---------------------------------------------------------------------------
// Export / import (for sharing personal layers via files)
// ---------------------------------------------------------------------------

/** Export a layer config as a downloadable JSON file. */
export function exportLayerAsJson(layer: LayerConfig): void {
  const json = JSON.stringify(layer, null, 2);
  const blob = new Blob([json], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${layer.id}.layer.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Import a layer config from a JSON file. Returns null on failure. */
export async function importLayerFromFile(
  file: File,
): Promise<LayerConfig | null> {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    return parseLayerConfig(raw);
  } catch {
    return null;
  }
}
