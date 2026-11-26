/**
 * Which folder holds an ARII export's sidecars, and which tables it has.
 *
 * Asked once, before the app is imported (main.tsx), because the room
 * store builds its data sources at module load, from config.ts:
 *  - the folder decides every sidecar URL;
 *  - the tables decide what the store loads. A pipeline-published
 *    `chemduck/` folder has ChemDuck's catalogues (analyte_summary, ...)
 *    and not Chemrooms' (analyte_catalog, location_analytes), and a url
 *    data source for a file that isn't there fails the whole load.
 *
 * Imports nothing with side effects (urls.ts, not config.ts).
 */

import {SIDECAR_FOLDERS, defaultSidecarFolder, joinUrl, sourceParams} from './urls';

export interface SidecarProbe {
  /** The sidecar folder URL, with the manifest's query string. */
  folder: string;
  /** The tables sidecars.json lists. */
  tables: string[];
}

let probed: SidecarProbe | null = null;

/** The probe's answer, or null when there was no ARII source or no folder. */
export function probedSidecars(): SidecarProbe | null {
  return probed;
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

/**
 * The first folder whose sidecars.json can be read: the named one when
 * there is one, else `chemduck/` then `chemrooms/` beside the manifest.
 * Null when none can, and openAriiResults then says why the source won't
 * open.
 */
export async function probeSidecars(
  manifestUrl: string,
  namedFolder: string | null,
  get: (url: string) => Promise<unknown> = fetchJson,
): Promise<SidecarProbe | null> {
  const candidates = namedFolder
    ? [namedFolder]
    : SIDECAR_FOLDERS.map((f) => defaultSidecarFolder(manifestUrl, f));
  for (const folder of candidates) {
    try {
      const sidecars = (await get(joinUrl(folder, 'sidecars.json'))) as {
        tables?: Record<string, unknown>;
      };
      if (sidecars && typeof sidecars === 'object' && sidecars.tables) {
        probed = {folder, tables: Object.keys(sidecars.tables)};
        return probed;
      }
    } catch {
      // not this one
    }
  }
  probed = null;
  return null;
}

/**
 * The manifest and named folder the app will open, by config.ts's order
 * (resolveSource): a link's manifest, then a link's ChemDuck folder (no
 * ARII), then the build's manifest. Null when the source isn't ARII.
 */
export function ariiToProbe(
  hash: string,
  env: {VITE_ARII_MANIFEST_URL?: string; VITE_DATA_URL?: string},
): {manifestUrl: string; namedFolder: string | null} | null {
  const link = sourceParams(hash);
  if (link.manifest) return {manifestUrl: link.manifest, namedFolder: link.data};
  if (link.data) return null;
  if (env.VITE_ARII_MANIFEST_URL) {
    return {manifestUrl: env.VITE_ARII_MANIFEST_URL, namedFolder: env.VITE_DATA_URL || null};
  }
  return null;
}
