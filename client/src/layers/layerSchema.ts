/**
 * Layer schema — the canonical representation of a "frozen" data view.
 *
 * A layer config is a small JSON recipe that fully describes:
 *   - WHERE the data comes from (built-in DuckDB tables or an external file)
 *   - HOW the data is filtered and aggregated (analyte, matrix, event_agg, etc.)
 *   - HOW the data is visually encoded (color column, palette, point size, etc.)
 *
 * It contains NO actual data — just parameters and references. At render
 * time, the client turns a layer config into a DuckDB query + Cesium
 * entities, pulling data from the project's parquet-backed tables or
 * from an external URL.
 *
 * The same schema is used for:
 *   - Shared layers (JSON files deployed with the project, read-only)
 *   - Personal layers (localStorage, per-user, read-write)
 *   - Bookmark layers (serialized into the URL hash for sharing)
 *   - Future: collaborative layers (stored via API, git-backed)
 *
 * The interactive sidebar state is conceptually an unsaved layer.
 * "Freezing" a layer = taking the current sidebar state and persisting
 * it as a LayerConfig with a name.
 *
 * ## Data source types
 *
 * `chemduck`
 *   The default. No external data — queries the project's DuckDB tables
 *   via aggregate_results(). The `query` field provides the parameters.
 *
 * `geoparquet`
 *   An external GeoParquet file loaded into DuckDB-WASM at runtime.
 *   The URL can be relative (static deploy) or absolute (object storage).
 *   Once loaded, the data is queryable like any other table.
 *
 * `geojson`
 *   A GeoJSON file loaded as Cesium entities (polygons, lines, points).
 *   Not loaded into DuckDB — rendered directly by Cesium.
 *
 * `geojson-inline`
 *   Small GeoJSON embedded directly in the layer config. For site
 *   boundaries, annotations, and other lightweight vectors that should
 *   travel with the config rather than requiring a separate fetch.
 *   Keep under ~50KB to stay URL-serializable.
 *
 * `imagery`
 *   A georeferenced raster image (PNG/JPEG) draped on terrain via
 *   Cesium's imagery layer system. For plume maps, aerial photos,
 *   interpolated surfaces, etc.
 */

import {z} from 'zod';
import {computeLayerHash} from './layerHash';

// ---------------------------------------------------------------------------
// Data source types
// ---------------------------------------------------------------------------

/**
 * The `dataSource` field is a typed reference: a discriminated union
 * keyed on `type`, where each variant identifies a different way of
 * resolving the layer's data. Future variants will include `blob`
 * (content-addressed bucket lookup), `alias` (named pointer at a blob),
 * and `preset` (institutional opinion library) — see the data
 * architecture proposal for the full vision. For now chemrooms only
 * uses `chemduck` (the in-process DuckDB schema, a "system" reference)
 * and the URL-based variants below.
 *
 * ## Pin vs float
 *
 * URL-based references are by-name, not by-content: the bytes at
 * `url` can change between visits without the reference itself
 * changing. By default this means a URL ref is **floating** — it
 * always resolves to whatever's at the URL right now, and the layer's
 * content hash captures only the URL string.
 *
 * To **pin** a URL ref to specific bytes, set `expectedHash` to the
 * SHA-256 of the file. The loader can then verify the bytes match,
 * and pinned refs participate in the layer's content hash, so a
 * pinned and an unpinned reference to the same URL produce different
 * layer ids. Pinning is what makes a deliverable reproducible: a
 * regulator submission from a year ago renders the same data today
 * because the bytes were pinned at publication time.
 *
 * ## Hash format
 *
 * Hashes inside `expectedHash` and future blob/alias references use
 * the algorithm-prefixed form `sha256:<hex>` so the schema can
 * accommodate other hash functions later without ambiguity. The
 * layer's own `id` is currently a bare 16-character hex truncation
 * of the SHA-256 — that legacy is preserved to avoid a second
 * migration of localStorage entries; the algorithm-prefix migration
 * for layer ids is intentionally deferred.
 */

/** Bounding box in WGS84 degrees. */
export const Extent = z.object({
  west: z.number(),
  south: z.number(),
  east: z.number(),
  north: z.number(),
});
export type Extent = z.infer<typeof Extent>;

/**
 * Algorithm-prefixed content hash, e.g. `sha256:3b7e3c6c5e...`. Used
 * to pin URL-based references to specific bytes for reproducibility.
 */
export const ContentHash = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64-hex>');
export type ContentHash = z.infer<typeof ContentHash>;

export const ChemduckDataSource = z.object({
  type: z.literal('chemduck'),
});

/**
 * Geometry types we recognize in the schema. Only `point` currently
 * flows through the SQL/entity rendering pipeline; line and polygon
 * variants are reserved for a future vector renderer (which will
 * convert WKB → Cesium polyline/polygon entities, probably via
 * ST_AsGeoJSON for simplicity). The dispatch decision lives in
 * buildLayerSql — non-point types return null SQL so the
 * entity-layer pipeline skips them and the vector renderer (when
 * built) picks them up via a separate dispatch path.
 */
export const GeometryType = z.enum([
  'point',
  'multipoint',
  'linestring',
  'multilinestring',
  'polygon',
  'multipolygon',
]);
export type GeometryType = z.infer<typeof GeometryType>;

export const GeoParquetDataSource = z.object({
  type: z.literal('geoparquet'),
  /** URL to the .geoparquet file (relative or absolute). */
  url: z.string(),
  /** Table name to register in DuckDB-WASM after loading. */
  tableName: z.string(),
  /** Optional pin: if set, loader verifies the source bytes match. */
  expectedHash: ContentHash.optional(),

  /**
   * Name of the WKB geometry column. The geoparquet convention is
   * `geometry`, but real-world files in the wild use whatever the
   * authoring tool emitted. The runtime loader can introspect the
   * parquet's `geo` metadata key to default this; users can override
   * via the layer config.
   */
  geometryColumn: z.string().default('geometry'),

  /**
   * Geometry type of the column above. Determines which render
   * pipeline handles this layer (point → entity pipeline, others →
   * future vector renderer). Defaults to `point` because that's the
   * only type currently rendered, but the field exists in the schema
   * so layers can be honest about non-point data and the dispatcher
   * can route correctly without guesswork.
   */
  geometryType: GeometryType.default('point'),

  /**
   * How the geometry column is physically stored.
   *
   * - `wkb` (default): raw WKB bytes in a BLOB column. This is what
   *   DuckDB's `read_parquet` returns for a geoparquet file by default,
   *   because plain `read_parquet` doesn't know about the geoparquet
   *   spec. The dispatcher wraps the column in `ST_GeomFromWKB(...)`
   *   so spatial functions can operate on it.
   *
   * - `native`: the column is already a DuckDB GEOMETRY type, e.g.
   *   when the file was loaded via `st_read` (which is GDAL-driven
   *   and gives proper geometries) or when a CREATE-TABLE-AS step
   *   has already wrapped the WKB. The dispatcher uses the column
   *   directly without wrapping.
   *
   * The runtime loader picks the right encoding based on which load
   * method it used. Defaults to wkb because that's the cheapest and
   * most-likely path for a freshly dropped geoparquet.
   */
  geometryEncoding: z.enum(['wkb', 'native']).default('wkb'),

  /**
   * Whether the geometry has a Z component. When true the dispatcher
   * pulls altitude via ST_Z; when false altitude is NULL and the
   * entity falls back to terrain-clamped rendering.
   */
  is3d: z.boolean().default(false),

  /**
   * Column to use as the entity id. Null = synthesize from row
   * number, which is always unique and always present, so a freshly
   * dragged-in file renders without the user having to specify
   * anything.
   */
  idColumn: z.string().nullable().default(null),

  /**
   * Column to use as the entity display label. Null = fall back to
   * the id column (or the synthesized row number).
   */
  labelColumn: z.string().nullable().default(null),

  /**
   * Source CRS as an EPSG ref (e.g. 'EPSG:26917'). Provenance only:
   * the runtime loader is responsible for reprojecting to EPSG:4326
   * at registration time using ST_Transform, so query-side SQL can
   * assume WGS84 throughout. Null = the source was already in 4326
   * or unknown / not yet introspected.
   */
  sourceCrs: z.string().nullable().default(null),

  /**
   * Column names to expose to click-to-attributes. The entity
   * renderer attaches these as properties on the created Cesium
   * entity so a click handler can pop a table. Empty array = no
   * attributes exposed (the layer is "see only"). The runtime
   * loader can default this to "all non-geometry columns" when
   * introspecting the parquet schema.
   */
  propertiesColumns: z.array(z.string()).default([]),
});
export type GeoParquetDataSource = z.infer<typeof GeoParquetDataSource>;

export const GeoJsonDataSource = z.object({
  type: z.literal('geojson'),
  /** URL to the .geojson file. */
  url: z.string(),
  /** Optional pin: if set, loader verifies the bytes match. */
  expectedHash: ContentHash.optional(),
});

export const GeoJsonInlineDataSource = z.object({
  type: z.literal('geojson-inline'),
  /** The GeoJSON FeatureCollection, embedded directly. */
  data: z.any(), // GeoJSON.FeatureCollection — validated at runtime by Cesium
});

export const ImageryDataSource = z.object({
  type: z.literal('imagery'),
  /** URL to the image file (PNG, JPEG, etc.). */
  url: z.string(),
  /** Geographic extent the image covers. */
  extent: Extent,
  /** Optional pin: if set, loader verifies the bytes match. */
  expectedHash: ContentHash.optional(),
});

export const DataSource = z.discriminatedUnion('type', [
  ChemduckDataSource,
  GeoParquetDataSource,
  GeoJsonDataSource,
  GeoJsonInlineDataSource,
  ImageryDataSource,
]);
export type DataSource = z.infer<typeof DataSource>;

// ---------------------------------------------------------------------------
// Query configuration (for chemduck and geoparquet sources)
// ---------------------------------------------------------------------------

/**
 * Parameters for the chemduck aggregate_results() macro.
 *
 * Field names match the chemduck aggregation_rules catalog vocabulary.
 * All filter fields are optional — omitting them means "no filter."
 */
export const QueryConfig = z.object({
  /** Analyte to filter on (exact match). Required for aggregation. */
  analyte: z.string(),
  /** Matrix filter. Null = all matrices. */
  matrix: z.string().nullable().default(null),
  /** Inclusive start date (ISO 8601). Null = no lower bound. */
  startDate: z.string().nullable().default(null),
  /** Inclusive end date (ISO 8601). Null = no upper bound. */
  endDate: z.string().nullable().default(null),
  /** Event-aggregation rule name (from aggregation_rules catalog). */
  eventAgg: z.string().default('most_recent'),
  /** Duplicate-aggregation rule name. */
  dupAgg: z.string().default('avg'),
  /** Non-detect substitution method name. */
  ndMethod: z.string().default('half_dl'),
});
export type QueryConfig = z.infer<typeof QueryConfig>;

// ---------------------------------------------------------------------------
// Visual encoding
// ---------------------------------------------------------------------------

/**
 * How the layer's data is rendered on the map.
 *
 * For `chemduck` and `geoparquet` sources, the default render type is
 * `point` (Cesium point entities). For `imagery`, it's `imagery`
 * (draped on terrain). For `geojson`/`geojson-inline`, it's `vector`
 * (Cesium polygon/polyline/point entities from GeoJSON geometry).
 *
 * Color fields can override or extend the vis spec defaults. If
 * omitted, the vis spec for the underlying table is used as-is.
 */
export const VisualEncoding = z.object({
  /** Render type hint. Inferred from dataSource.type if omitted. */
  renderType: z
    .enum(['point', 'vector', 'imagery'])
    .default('point'),
  /** Column to color by. Null = default from vis spec or single color. */
  colorBy: z.string().nullable().default(null),
  /** Override the vis spec's default palette for this layer. */
  palette: z.string().optional(),
  /** Override the scale type for sequential coloring. */
  scaleType: z.enum(['linear', 'log', 'sqrt']).optional(),
  /** Override the domain for sequential coloring. Null = derive from data. */
  domain: z.tuple([z.number(), z.number()]).optional(),
  /** Point size in pixels (for point render type). */
  pointSize: z.number().default(8),
  /** Opacity (0–1). */
  opacity: z.number().min(0).max(1).default(1),
  /** Solid fallback color (CSS string) when colorBy is null. */
  color: z.string().default('#00ffff'),
});
export type VisualEncoding = z.infer<typeof VisualEncoding>;

// ---------------------------------------------------------------------------
// Full layer config
// ---------------------------------------------------------------------------

export const LayerConfig = z.object({
  /** Schema version. Increment on breaking changes. */
  version: z.literal(1).default(1),

  /**
   * Stable identifier. For shared layers, this is the filename stem
   * (e.g. "benzene-gw-most-recent"). For personal and bookmark layers,
   * a 16-hex-char content hash (SHA-256 over the essential fields).
   * Two users freezing the same recipe get the same id; editing
   * cosmetic fields (name, description) preserves it.
   */
  id: z.string(),

  /** Human-readable display name. */
  name: z.string(),

  /** Optional longer description (shown in tooltips, layer panel). */
  description: z.string().optional(),

  // ── Data ──────────────────────────────────────────────────────────

  /**
   * Where the layer's data comes from.
   * Defaults to `{type: 'chemduck'}` (query the built-in DuckDB tables).
   */
  dataSource: DataSource.default({type: 'chemduck'}),

  /**
   * Query parameters for chemduck aggregate_results().
   * Only meaningful when dataSource.type is 'chemduck'.
   * Omit for non-query layers (imagery, raw geojson).
   */
  query: QueryConfig.optional(),

  // ── Visual ────────────────────────────────────────────────────────

  /** How to render the data. */
  visual: VisualEncoding.default({}),

  /** Whether the layer is currently visible on the map. */
  visible: z.boolean().default(true),

  // ── Metadata ──────────────────────────────────────────────────────

  /** ISO 8601 timestamp of when the layer was created/frozen. */
  createdAt: z.string().optional(),

  /**
   * Where this layer config was loaded from. Not persisted — set at
   * runtime by the loader so the UI can distinguish shared vs personal.
   */
  origin: z
    .enum(['shared', 'personal', 'bookmark'])
    .optional(),
});
export type LayerConfig = z.infer<typeof LayerConfig>;

// ---------------------------------------------------------------------------
// Layer manifest (for shared layers deployed as static files)
// ---------------------------------------------------------------------------

/**
 * The manifest file (`layers/manifest.json`) lists all shared layers
 * available in the current deployment. Built at deploy time by a
 * manifest builder script (similar to the tiles manifest).
 */
export const LayerManifest = z.object({
  layers: z.array(
    z.object({
      /** Filename stem, used as the layer id. */
      id: z.string(),
      /** Relative path to the layer config JSON file. */
      url: z.string(),
    }),
  ),
});
export type LayerManifest = z.infer<typeof LayerManifest>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + validate a layer config from unknown JSON. */
export function parseLayerConfig(raw: unknown): LayerConfig | null {
  const result = LayerConfig.safeParse(raw);
  if (!result.success) {
    console.warn('[layer] failed to parse config:', result.error);
    return null;
  }
  return result.data;
}

/**
 * Build a LayerConfig from the current interactive sidebar state.
 * This is the "freeze" operation — snapshot the current view as a
 * named, persistable layer config.
 *
 * The id is derived from the content hash: two users who freeze the
 * same recipe get the same id, and re-freezing is idempotent. Async
 * because Web Crypto's digest() returns a Promise.
 */
export async function freezeCurrentState(params: {
  name: string;
  description?: string;
  analyte: string;
  matrix: string | null;
  eventAgg: string;
  dupAgg: string;
  ndMethod: string;
  colorBy: string | null;
  palette?: string;
  scaleType?: 'linear' | 'log' | 'sqrt';
}): Promise<LayerConfig> {
  const draft: LayerConfig = {
    version: 1,
    id: '',
    name: params.name,
    description: params.description,
    dataSource: {type: 'chemduck'},
    query: {
      analyte: params.analyte,
      matrix: params.matrix,
      startDate: null,
      endDate: null,
      eventAgg: params.eventAgg,
      dupAgg: params.dupAgg,
      ndMethod: params.ndMethod,
    },
    visual: {
      renderType: 'point',
      colorBy: params.colorBy,
      palette: params.palette,
      scaleType: params.scaleType,
      pointSize: 8,
      opacity: 1,
      color: '#00ffff',
    },
    visible: true,
    createdAt: new Date().toISOString(),
    origin: 'personal',
  };
  const id = await computeLayerHash(draft);
  return {...draft, id};
}

/**
 * Serialize a layer config to a compact string suitable for URL hash
 * parameters. Uses JSON + URI encoding. For chemduck recipe-only layers
 * this is typically 200-400 bytes.
 */
export function serializeLayerForUrl(layer: LayerConfig): string {
  // Strip defaults and metadata to minimize URL length
  const compact: Record<string, unknown> = {
    id: layer.id,
    n: layer.name,
  };
  if (layer.query) {
    compact.q = {
      a: layer.query.analyte,
      ...(layer.query.matrix && {m: layer.query.matrix}),
      ...(layer.query.startDate && {sd: layer.query.startDate}),
      ...(layer.query.endDate && {ed: layer.query.endDate}),
      ...(layer.query.eventAgg !== 'most_recent' && {ea: layer.query.eventAgg}),
      ...(layer.query.dupAgg !== 'avg' && {da: layer.query.dupAgg}),
      ...(layer.query.ndMethod !== 'half_dl' && {nd: layer.query.ndMethod}),
    };
  }
  if (layer.visual.colorBy) compact.cb = layer.visual.colorBy;
  if (layer.visual.palette) compact.p = layer.visual.palette;
  if (layer.visual.scaleType) compact.st = layer.visual.scaleType;
  if (!layer.visible) compact.v = 0;
  return encodeURIComponent(JSON.stringify(compact));
}

/**
 * Deserialize a layer config from a URL hash string produced by
 * serializeLayerForUrl. Returns null if parsing fails.
 */
export function deserializeLayerFromUrl(encoded: string): LayerConfig | null {
  try {
    const compact = JSON.parse(decodeURIComponent(encoded));
    const query = compact.q
      ? {
          analyte: compact.q.a,
          matrix: compact.q.m ?? null,
          startDate: compact.q.sd ?? null,
          endDate: compact.q.ed ?? null,
          eventAgg: compact.q.ea ?? 'most_recent',
          dupAgg: compact.q.da ?? 'avg',
          ndMethod: compact.q.nd ?? 'half_dl',
        }
      : undefined;

    return parseLayerConfig({
      version: 1,
      id: compact.id,
      name: compact.n,
      dataSource: {type: 'chemduck'},
      query,
      visual: {
        renderType: 'point',
        colorBy: compact.cb ?? null,
        palette: compact.p,
        scaleType: compact.st,
      },
      visible: compact.v !== 0,
      origin: 'bookmark',
    });
  } catch {
    return null;
  }
}
