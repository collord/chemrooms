/**
 * Which project the app opens, and how to build URLs into it.
 *
 * Kept in its own module so setup code can read it without importing the
 * room store (which would create an import cycle through the panels).
 *
 * A project is chosen, in order, by:
 *
 *  1. The URL fragment: `#manifest=<ARII manifest.json>` (with an optional
 *     `&data=<sidecar folder>`), or `#data=<ChemDuck data folder>`. This is
 *     how the hosted app opens data it was not built with. The fragment is
 *     never sent to the web server, so a signed URL (an Azure SAS token)
 *     in it stays in the browser rather than in the host's logs.
 *  2. Build-time env vars: VITE_ARII_MANIFEST_URL, VITE_DATA_URL.
 *  3. In `pnpm dev` only, the demo data at http://localhost:8000/data.
 *
 * None of these: no project. The app shows the connect screen instead of
 * loading anything (the hosted build ships no data).
 *
 * The choice is read once, at load: changing it reloads the page, because
 * the room store and its data sources are created at module load.
 */

import {probedSidecars} from './sidecarProbe';
import {defaultSidecarFolder, joinUrl, sourceParams} from './urls';

export {
  DEFAULT_SIDECAR_FOLDER,
  SIDECAR_FOLDERS,
  SOURCE_PARAMS,
  defaultSidecarFolder,
  joinUrl,
  sourceParams,
} from './urls';

export type ProjectKind = 'arii' | 'chemduck';

export interface ProjectSource {
  kind: ProjectKind;
  /**
   * The data folder: for ChemDuck, the parquet tables, vis specs and `sql/`;
   * for ARII, the sidecar folder: `chemduck/` from the QGIS plugin's
   * pipeline, or `chemrooms/` from server/publish_arii.py. May carry a query
   * string (a signed URL); build paths into it with joinUrl.
   */
  dataBaseUrl: string;
  /** ARII only: the export's manifest.json, which names the partitions. */
  manifestUrl: string | null;
  /** Where the choice came from, for display and for bookmark links. */
  from: 'link' | 'build' | 'dev-default';
}

/**
 * Resolve the project from the fragment, then env, then the dev default.
 *
 * `foundSidecars` is the sidecar folder main.tsx found beside an ARII
 * manifest (sidecarProbe.ts), used when the source names none. Without one,
 * the first of SIDECAR_FOLDERS is assumed, and opening it says what's wrong.
 */
export function resolveSource(
  hash: string,
  env: {VITE_ARII_MANIFEST_URL?: string; VITE_DATA_URL?: string},
  dev: boolean,
  foundSidecars: string | null = null,
): ProjectSource | null {
  const link = sourceParams(hash);
  if (link.manifest) {
    return {
      kind: 'arii',
      manifestUrl: link.manifest,
      dataBaseUrl: link.data ?? foundSidecars ?? defaultSidecarFolder(link.manifest),
      from: 'link',
    };
  }
  if (link.data) {
    return {kind: 'chemduck', manifestUrl: null, dataBaseUrl: link.data, from: 'link'};
  }
  if (env.VITE_ARII_MANIFEST_URL) {
    return {
      kind: 'arii',
      manifestUrl: env.VITE_ARII_MANIFEST_URL,
      dataBaseUrl:
        env.VITE_DATA_URL || foundSidecars || defaultSidecarFolder(env.VITE_ARII_MANIFEST_URL),
      from: 'build',
    };
  }
  if (env.VITE_DATA_URL) {
    return {kind: 'chemduck', manifestUrl: null, dataBaseUrl: env.VITE_DATA_URL, from: 'build'};
  }
  if (dev) {
    return {
      kind: 'chemduck',
      manifestUrl: null,
      dataBaseUrl: 'http://localhost:8000/data',
      from: 'dev-default',
    };
  }
  return null;
}

export const PROJECT_SOURCE: ProjectSource | null = resolveSource(
  typeof window === 'undefined' ? '' : window.location.hash,
  import.meta.env,
  import.meta.env.DEV,
  probedSidecars()?.folder ?? null,
);

/**
 * The tables an ARII source's sidecars.json lists, as main.tsx found them
 * before the app loaded (sidecarProbe.ts); null when it found none, or the
 * source isn't ARII.
 */
export const SIDECAR_TABLES: readonly string[] | null = probedSidecars()?.tables ?? null;

/**
 * Base URL of the project's data folder ('' when there is none). The
 * ChemDuck SQL lives under `sql/` beside the data, because it is versioned
 * with the schema the data was written in, not with the client.
 */
export const DATA_BASE_URL: string = PROJECT_SOURCE?.dataBaseUrl ?? '';

/**
 * The ARII export's manifest.json, or null for a ChemDuck project. A signed
 * URL may carry its token in the query string; it is appended to each
 * partition URL and never written into a view.
 */
export const ARII_MANIFEST_URL: string | null = PROJECT_SOURCE?.manifestUrl ?? null;

/** A file in the project's data folder. */
export function dataUrl(path: string): string {
  return joinUrl(DATA_BASE_URL, path);
}

/** The fragment that reopens a project, for links and bookmarks. */
export function sourceHash(source: {manifest?: string | null; data?: string | null}): string {
  const params = new URLSearchParams();
  if (source.manifest) params.set('manifest', source.manifest);
  if (source.data) params.set('data', source.data);
  return params.toString();
}
