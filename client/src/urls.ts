/**
 * URL helpers for choosing a project, with no side effects at import.
 *
 * config.ts resolves the project when it is first imported, and main.tsx
 * has to look for an ARII export's sidecar folder before that happens
 * (sidecarProbe.ts). So the pieces both need live here, and config.ts
 * re-exports them.
 */

/** Fragment keys that select the project. Bookmarks keep them. */
export const SOURCE_PARAMS = ['manifest', 'data'] as const;

/**
 * The folders an ARII export's sidecars are looked for in, beside its
 * manifest, in order, when no folder is named:
 *
 *  - `chemduck/`: what the QGIS plugin's nightly pipeline publishes
 *    (parquet_source/chemduck_sidecars.py), with ChemDuck's own catalogues;
 *  - `chemrooms/`: what server/publish_arii.py wrote before that, with
 *    Chemrooms' catalogues and vis specs. Kept for exports published so.
 */
export const SIDECAR_FOLDERS = ['chemduck', 'chemrooms'] as const;

/** The first of SIDECAR_FOLDERS, used when none could be checked. */
export const DEFAULT_SIDECAR_FOLDER = SIDECAR_FOLDERS[0];

/**
 * `path` inside `base`, keeping base's query string LAST. Appending a path
 * after `?sv=...&sig=...` is the classic way to send a signed URL to the
 * wrong blob, and a plain `${base}/${path}` does exactly that.
 */
export function joinUrl(base: string, path: string): string {
  const q = base.indexOf('?');
  const root = (q >= 0 ? base.slice(0, q) : base).replace(/\/+$/, '');
  const query = q >= 0 ? base.slice(q) : '';
  return `${root}/${path.replace(/^\/+/, '')}${query}`;
}

/** A sidecar folder beside a manifest URL, with the manifest's query string. */
export function defaultSidecarFolder(
  manifestUrl: string,
  folder: string = DEFAULT_SIDECAR_FOLDER,
): string {
  const q = manifestUrl.indexOf('?');
  const path = q >= 0 ? manifestUrl.slice(0, q) : manifestUrl;
  const query = q >= 0 ? manifestUrl.slice(q) : '';
  return path.slice(0, path.lastIndexOf('/') + 1) + folder + query;
}

/** The source-selecting fragment parameters, if any. */
export function sourceParams(hash: string): {manifest: string | null; data: string | null} {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return {
    manifest: params.get('manifest') || null,
    data: params.get('data') || null,
  };
}
