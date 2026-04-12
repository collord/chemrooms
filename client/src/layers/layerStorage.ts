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
 * Add a personal layer and persist. Rehashes the layer's id from its
 * content so imported/promoted layers always get a canonical id, and
 * dedupes against existing layers with the same hash.
 *
 * If a layer with the same content hash already exists, this is a
 * no-op — the existing list is returned unchanged. Returns a tuple of
 * (updated list, whether a new layer was added).
 */
export async function addPersonalLayer(
  layer: LayerConfig,
): Promise<{layers: LayerConfig[]; added: boolean; id: string}> {
  const id = await computeLayerHash(layer);
  const existing = loadPersonalLayers();
  if (existing.some((l) => l.id === id)) {
    return {layers: existing, added: false, id};
  }
  const updated = [
    ...existing,
    {...layer, id, origin: 'personal' as const},
  ];
  savePersonalLayers(updated);
  return {layers: updated, added: true, id};
}

/**
 * One-time migration for personal layers: rehash any entries whose id
 * doesn't match their content (legacy UUID-based ids, or layers that
 * were tampered with). Dedupes in case two legacy layers collapse to
 * the same hash. Persists the result.
 */
export async function migratePersonalLayers(): Promise<LayerConfig[]> {
  const existing = loadPersonalLayers();
  if (existing.length === 0) return existing;

  const seen = new Set<string>();
  const migrated: LayerConfig[] = [];
  let changed = false;

  for (const layer of existing) {
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

  if (changed) savePersonalLayers(migrated);
  return migrated;
}

/** Remove a personal layer by id and persist. */
export function removePersonalLayer(id: string): LayerConfig[] {
  const existing = loadPersonalLayers();
  const updated = existing.filter((l) => l.id !== id);
  savePersonalLayers(updated);
  return updated;
}

/** Update a personal layer's visibility and persist. */
export function togglePersonalLayerVisibility(id: string): LayerConfig[] {
  const existing = loadPersonalLayers();
  const updated = existing.map((l) =>
    l.id === id ? {...l, visible: !l.visible} : l,
  );
  savePersonalLayers(updated);
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
