/**
 * Content-addressed identity for layer configs.
 *
 * The "essential" fields of a LayerConfig — what it actually shows on
 * the map — are hashed to produce a stable id. Cosmetic fields (name,
 * description, createdAt, origin, visible) are NOT part of the hash,
 * so they can be edited without changing the layer's identity.
 *
 * Two users who freeze the exact same recipe (same analyte, matrix,
 * filters, aggregation, color encoding) get the same id. Two users
 * with different recipes get different ids — even if they happen to
 * use the same name.
 *
 * Importing a layer file whose hash already exists locally is a no-op
 * (handled in addPersonalLayer). Re-freezing the same recipe is also
 * a no-op. The user can't accidentally accumulate duplicates.
 *
 * Hash function: SHA-256 truncated to 16 hex chars (8 bytes / 64 bits).
 * Collision probability for any realistic project (millions of layers)
 * is negligibly small.
 */

import type {LayerConfig} from './layerSchema';

/**
 * Build the canonical representation of a layer for hashing — only
 * the fields that determine what the layer SHOWS, sorted into a
 * deterministic key order so the same content always serializes the
 * same bytes.
 */
function canonicalize(layer: LayerConfig): string {
  // We deliberately rebuild the object key-by-key in a fixed order
  // rather than relying on JSON.stringify with a replacer/sorter.
  // Explicit > clever for hashing.
  const canon: Record<string, unknown> = {
    version: layer.version,
    dataSource: canonicalizeDataSource(layer.dataSource),
  };
  if (layer.query) {
    canon.query = canonicalizeQuery(layer.query);
  }
  canon.visual = canonicalizeVisual(layer.visual);
  return JSON.stringify(canon);
}

function canonicalizeDataSource(ds: LayerConfig['dataSource']): unknown {
  // Discriminated union — branch on type then list fields in known order
  switch (ds.type) {
    case 'chemduck':
      return {type: 'chemduck'};
    case 'geoparquet':
      return {type: 'geoparquet', url: ds.url, tableName: ds.tableName};
    case 'geojson':
      return {type: 'geojson', url: ds.url};
    case 'geojson-inline':
      // Inline data is already JSON; we use it directly
      return {type: 'geojson-inline', data: ds.data};
    case 'imagery':
      return {
        type: 'imagery',
        url: ds.url,
        extent: {
          west: ds.extent.west,
          south: ds.extent.south,
          east: ds.extent.east,
          north: ds.extent.north,
        },
      };
  }
}

function canonicalizeQuery(q: NonNullable<LayerConfig['query']>): unknown {
  return {
    analyte: q.analyte,
    matrix: q.matrix ?? null,
    startDate: q.startDate ?? null,
    endDate: q.endDate ?? null,
    eventAgg: q.eventAgg,
    dupAgg: q.dupAgg,
    ndMethod: q.ndMethod,
  };
}

function canonicalizeVisual(v: LayerConfig['visual']): unknown {
  return {
    renderType: v.renderType,
    colorBy: v.colorBy ?? null,
    palette: v.palette ?? null,
    scaleType: v.scaleType ?? null,
    domain: v.domain ?? null,
    pointSize: v.pointSize,
    opacity: v.opacity,
    color: v.color,
  };
}

/**
 * Compute the SHA-256 hash of a layer's canonical content and return
 * the first 16 hex chars as the layer id. Async because Web Crypto's
 * `subtle.digest` returns a Promise.
 */
export async function computeLayerHash(layer: LayerConfig): Promise<string> {
  const canon = canonicalize(layer);
  const bytes = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}

/**
 * Check whether a layer's id matches its content hash. Used to detect
 * UUID-based legacy layers that need migrating.
 */
export async function isHashedId(layer: LayerConfig): Promise<boolean> {
  // Quick check: hash ids are 16 lowercase hex chars
  if (!/^[0-9a-f]{16}$/.test(layer.id)) return false;
  // Verify it matches the content
  const expected = await computeLayerHash(layer);
  return expected === layer.id;
}
