/**
 * Tileset manager — fetches the tileset manifest, manages
 * Cesium3DTileset instances, exposes a list with toggle functions.
 *
 * Returns an object with:
 *   - tilesets: list of {name, url, visible} entries from the manifest
 *   - tilesetRefs: ref to the loaded Cesium3DTileset instances (used by
 *     the clipping plane sync hook)
 *   - toggleTileset(name): show/hide a tileset, loading it on first show
 *   - tilesetColors: per-tileset {top, bottom} hex colors
 *   - setTilesetColors(name, top, bottom): update face colors live
 *
 * Cleanup on unmount removes all loaded tilesets from the viewer.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {
  BoundingSphere,
  Cartesian3,
  Cesium3DTileset,
  CustomShader,
  Model,
  Rectangle,
  UniformType,
} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {applyClippingToTileset, planeFromPoints} from '../lib/clippingPlane';
import type {CrossSectionMode} from '../slices/chemrooms-slice';
import {setLayerBbox} from '../layers/layerBbox';

/** WGS84 rectangle in degrees, optionally on a manifest entry. */
export interface TilesetExtentWgs84 {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TilesetEntry {
  name: string;
  url: string; // relative to BASE_URL
  visible: boolean;
  /**
   * If true, the tileset's glTF/GLB carries EXT_structural_metadata +
   * EXT_mesh_features and should keep its embedded materials (no
   * top/bottom face-color shader). Per-feature picking will route to
   * the Inspector's tile-feature variant.
   */
  hasFeatureMetadata?: boolean;
  /**
   * Optional WGS84 footprint. When present, the tileset contributes to
   * the project bbox / zoomToFit union while visible. Authored in the
   * manifest so we don't depend on Cesium's loose boundingSphere.
   */
  _extent_wgs84?: TilesetExtentWgs84;
}

/** layerBbox registry key for a tileset entry. */
const tilesetBboxKey = (name: string) => `tileset:${name}`;

/**
 * One sub-node from a metadata-carrying GLB. Each top-level glTF
 * scene node becomes a SubNode; the user can toggle them
 * individually in the LayersPanel.
 */
export interface SubNodeInfo {
  /** glTF node name (also the EXT_structural_metadata class name). */
  name: string;
  /** Feature count from the matching property table, when known. */
  featureCount?: number;
  /** Current visibility — drives ModelNode.show. */
  visible: boolean;
  /**
   * The node's bounding sphere in ECEF, captured at ready time. Used
   * to compute a drilled-down WGS84 bbox when only some sub-nodes are
   * visible. May be undefined for nodes whose primitive bounds aren't
   * exposed.
   */
  boundingSphere?: BoundingSphere;
}

/**
 * Reverse-lookup: loaded primitive (Cesium3DTileset OR Model) →
 * manifest name. Populated when a primitive finishes loading; read by
 * the click handler in useLocationClick so a picked ModelFeature can
 * be tagged with the originating tileset name.
 *
 * A single WeakMap covers both kinds so the picker doesn't need to
 * know which loader was used.
 */
export const tilesetNameByInstance = new WeakMap<object, string>();

export interface TilesetColors {
  top: string;    // hex — outside / upward-facing surfaces
  bottom: string; // hex — inside / downward-facing surfaces
}

export const DEFAULT_TOP_COLOR = '#add8e6';    // light blue
export const DEFAULT_BOTTOM_COLOR = '#ffb6c1'; // light pink

const BASE_URL = import.meta.env.BASE_URL;

function hexToCartesian3(hex: string): Cartesian3 {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return new Cartesian3(r, g, b);
}

/**
 * Build a CustomShader that colors faces by whether their world-space
 * normal points away from (top) or toward (bottom) Earth's center.
 * positionEC → world space via czm_inverseView gives us the radial "up"
 * at each fragment; dot with the world-space normal gives the sign.
 */
function buildFaceColorShader(top: string, bottom: string): CustomShader {
  return new CustomShader({
    uniforms: {
      u_topColor: {type: UniformType.VEC3, value: hexToCartesian3(top)},
      u_bottomColor: {type: UniformType.VEC3, value: hexToCartesian3(bottom)},
    },
    fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 normalEC  = fsInput.attributes.normalEC;
  vec4 worldPos4 = czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0);
  vec3 worldUp   = normalize(worldPos4.xyz);
  vec3 worldNorm = normalize(mat3(czm_inverseView) * normalEC);
  material.diffuse = dot(worldNorm, worldUp) >= 0.0 ? u_topColor : u_bottomColor;
}`,
  });
}

/**
 * Walk a loaded Model's scene graph and produce a SubNodeInfo entry
 * per top-level node. Uses private fields on the runtime objects
 * (Cesium doesn't expose this through a public API), guarded with
 * defensive optional chaining — if Cesium changes shape internally
 * we degrade to "no sub-nodes" rather than throwing.
 *
 * Feature counts are sourced from the EXT_structural_metadata property
 * tables, matched by class name (== node name in this GLB).
 */
function discoverSubNodes(model: Model): SubNodeInfo[] {
  const sceneGraph = (model as unknown as {_sceneGraph?: unknown})._sceneGraph as
    | {
        _runtimeNodes?: Array<
          | {
              _name?: string;
              show?: boolean;
              runtimePrimitives?: Array<{boundingSphere?: BoundingSphere}>;
            }
          | undefined
        >;
        components?: {
          scene?: {nodes?: Array<{name?: string}>};
          nodes?: Array<{name?: string}>;
        };
      }
    | undefined;
  if (!sceneGraph) {
    console.warn('[discoverSubNodes] no _sceneGraph on model');
    return [];
  }
  const runtimeNodes = sceneGraph._runtimeNodes ?? [];
  console.log(
    `[discoverSubNodes] runtimeNodes=${runtimeNodes.length} ` +
      `componentsNodes=${sceneGraph.components?.nodes?.length ?? 0} ` +
      `sceneNodes=${sceneGraph.components?.scene?.nodes?.length ?? 0}`,
  );

  // Build a featureCount lookup by class name from the property tables.
  const propertyTables = (
    model as unknown as {
      structuralMetadata?: {propertyTables?: Array<{class?: {id?: string}; count?: number}>};
    }
  ).structuralMetadata?.propertyTables;
  const countByClass = new Map<string, number>();
  if (propertyTables) {
    for (const pt of propertyTables) {
      const id = pt?.class?.id;
      if (id && typeof pt.count === 'number') {
        countByClass.set(id, pt.count);
      }
    }
  }

  const out: SubNodeInfo[] = [];
  const staticNodes = sceneGraph.components?.nodes ?? [];
  for (let i = 0; i < runtimeNodes.length; i++) {
    const runtime = runtimeNodes[i];
    // Prefer the runtime node's name; fall back to the static glTF
    // components.nodes[i].name (always present after parsing) so we
    // still get the list even if runtime population is partial.
    const name = runtime?._name ?? staticNodes[i]?.name;
    if (!name) continue;
    let sphere: BoundingSphere | undefined;
    const prims = runtime?.runtimePrimitives ?? [];
    for (const p of prims) {
      if (!p.boundingSphere) continue;
      sphere = sphere
        ? BoundingSphere.union(sphere, p.boundingSphere, new BoundingSphere())
        : BoundingSphere.clone(p.boundingSphere, new BoundingSphere());
    }
    out.push({
      name,
      featureCount: countByClass.get(name),
      visible: runtime?.show ?? true,
      boundingSphere: sphere,
    });
  }
  return out;
}

/**
 * Fetch a GLB and strip EXT_structural_metadata + EXT_mesh_features before
 * passing it to Cesium. The property tables reference accessor indices that
 * don't exist, causing a non-recoverable RangeError inside Cesium's accessor
 * pipeline. EXT_mesh_features must also be stripped because Cesium's
 * buildRenderResources reads featuresLength off the feature table — which is
 * null when the structural metadata is absent — and throws a TypeError.
 */
async function loadGlbSafe(url: string): Promise<ArrayBuffer> {
  const raw = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    return r.arrayBuffer();
  });

  const view = new DataView(raw);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) return raw; // not GLB — pass through

  const jsonChunkLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(raw, 20, jsonChunkLength);
  let gltfJson: Record<string, unknown>;
  try {
    gltfJson = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>;
  } catch {
    return raw; // malformed JSON chunk — pass through
  }

  const extensions = gltfJson.extensions as Record<string, unknown> | undefined;
  if (!extensions?.EXT_structural_metadata) return raw; // nothing to strip

  const STRIP = ['EXT_structural_metadata', 'EXT_mesh_features'];
  console.warn(`[loadGlbSafe] stripping ${STRIP.join(', ')} — malformed property table accessor indices`);

  // Strip from top-level extensions, extensionsUsed, extensionsRequired.
  const cleanedExtensions = {...extensions};
  for (const ext of STRIP) delete cleanedExtensions[ext];
  gltfJson = {
    ...gltfJson,
    extensions: cleanedExtensions,
    extensionsUsed: ((gltfJson.extensionsUsed as string[] | undefined) ?? [])
      .filter((e) => !STRIP.includes(e)),
    extensionsRequired: ((gltfJson.extensionsRequired as string[] | undefined) ?? [])
      .filter((e) => !STRIP.includes(e)),
  };

  // Strip EXT_mesh_features from every mesh primitive.
  const meshes = gltfJson.meshes as Array<{primitives?: Array<{extensions?: Record<string, unknown>}>}> | undefined;
  if (meshes) {
    for (const mesh of meshes) {
      for (const prim of mesh.primitives ?? []) {
        if (prim.extensions) {
          const primExts = {...prim.extensions};
          for (const ext of STRIP) delete primExts[ext];
          prim.extensions = primExts;
        }
      }
    }
  }

  // Repack the JSON chunk (pad to 4-byte alignment with spaces per GLB spec).
  const newJsonStr = JSON.stringify(gltfJson);
  let jsonPadded = newJsonStr;
  while (jsonPadded.length % 4 !== 0) jsonPadded += ' ';
  const newJsonBytes = new TextEncoder().encode(jsonPadded);

  const binOffset = 20 + jsonChunkLength;
  const binBytes = new Uint8Array(raw, binOffset);
  const totalLength = 12 + 8 + newJsonBytes.length + binBytes.length;

  const out = new ArrayBuffer(totalLength);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);

  outView.setUint32(0, 0x46546c67, true); // magic 'glTF'
  outView.setUint32(4, 2, true);           // version 2
  outView.setUint32(8, totalLength, true);
  outView.setUint32(12, newJsonBytes.length, true);
  outView.setUint32(16, 0x4e4f534a, true); // chunk type 'JSON'
  outBytes.set(newJsonBytes, 20);
  outBytes.set(binBytes, 20 + newJsonBytes.length);

  return out;
}

export function useTilesetManager() {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );
  const crossSectionMode = useChemroomsStore(
    (s) => s.chemrooms.crossSectionMode,
  );
  const sliceThicknessM = useChemroomsStore(
    (s) => s.chemrooms.sliceThicknessM,
  );

  const [tilesets, setTilesets] = useState<TilesetEntry[]>([]);
  const tilesetRefs = useRef<Record<string, Cesium3DTileset>>({});
  /**
   * Models loaded directly from a .glb (manifest entries with
   * hasFeatureMetadata=true). Kept separate from tilesetRefs because
   * Model and Cesium3DTileset have different APIs — clipping plane
   * sync and the face-color shader only target Cesium3DTilesets.
   */
  const modelRefs = useRef<Record<string, Model>>({});

  /**
   * Per-tileset sub-node lists, populated when a Model's readyEvent
   * fires. Empty arrays mean "no sub-nodes discovered yet" (either
   * the model isn't loaded or it's a Cesium3DTileset).
   */
  const [subNodes, setSubNodes] = useState<Record<string, SubNodeInfo[]>>({});
  const subNodesRef = useRef<Record<string, SubNodeInfo[]>>({});

  // Per-tileset face colors. A ref keeps the value always current inside
  // the toggleTileset callback without adding it to the dep array.
  const [tilesetColors, setTilesetColorsState] = useState<
    Record<string, TilesetColors>
  >({});
  const tilesetColorsRef = useRef<Record<string, TilesetColors>>({});

  // Fetch manifest on mount
  useEffect(() => {
    fetch(`${BASE_URL}tiles/manifest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => {
        const entries = (data.tilesets ?? []).map(
          (t: {name: string; url: string; hasFeatureMetadata?: boolean}) => ({
            ...t,
            visible: false,
          }),
        );
        setTilesets(entries);
      })
      .catch((e) => console.warn('[tilesets] no manifest:', e));
  }, []);

  // Clean up tilesets + models on unmount
  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return;
      for (const name of Object.keys(tilesetRefs.current)) {
        viewer.scene.primitives.remove(tilesetRefs.current[name]);
        setLayerBbox(tilesetBboxKey(name), null);
      }
      tilesetRefs.current = {};
      for (const name of Object.keys(modelRefs.current)) {
        viewer.scene.primitives.remove(modelRefs.current[name]);
        setLayerBbox(tilesetBboxKey(name), null);
      }
      modelRefs.current = {};
      subNodesRef.current = {};
    };
  }, [viewer]);

  /**
   * Recompute the WGS84 bbox contributed by a metadata tileset based
   * on which sub-nodes are visible. Three cases:
   *  - All sub-nodes hidden → no bbox.
   *  - All sub-nodes visible → use the manifest's _extent_wgs84.
   *  - Mixed → union of visible nodes' bounding-sphere extents.
   */
  const refreshSubNodeBbox = useCallback(
    (entry: TilesetEntry, nodes: SubNodeInfo[]) => {
      const key = tilesetBboxKey(entry.name);
      const visibleNodes = nodes.filter((n) => n.visible);
      if (visibleNodes.length === 0) {
        setLayerBbox(key, null);
        return;
      }
      if (visibleNodes.length === nodes.length && entry._extent_wgs84) {
        setLayerBbox(key, entry._extent_wgs84);
        return;
      }

      // Union the per-node WGS84 rectangles. Rectangle.fromBoundingSphere
      // returns radians; convert at the end. Spheres are loose fits so the
      // result is conservative — fine for zoom-to-fit framing.
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      let any = false;
      for (const n of visibleNodes) {
        if (!n.boundingSphere) continue;
        const rect = Rectangle.fromBoundingSphere(n.boundingSphere);
        west = Math.min(west, rect.west);
        south = Math.min(south, rect.south);
        east = Math.max(east, rect.east);
        north = Math.max(north, rect.north);
        any = true;
      }
      if (!any) {
        // Fall back to manifest extent if node spheres weren't captured.
        setLayerBbox(key, entry._extent_wgs84 ?? null);
        return;
      }
      const RAD2DEG = 180 / Math.PI;
      setLayerBbox(key, {
        west: west * RAD2DEG,
        south: south * RAD2DEG,
        east: east * RAD2DEG,
        north: north * RAD2DEG,
      });
    },
    [],
  );

  /**
   * Toggle visibility of one sub-node inside a metadata GLB. Mutates
   * ModelNode.show directly (which Cesium re-reads each frame) and
   * updates the React state used to drive the LayersPanel tree.
   */
  const setSubNodeVisible = useCallback(
    (tilesetName: string, nodeName: string, visible: boolean) => {
      const model = modelRefs.current[tilesetName];
      if (model) {
        try {
          const node = model.getNode(nodeName);
          if (node) node.show = visible;
        } catch (e) {
          console.warn(
            `[tileset:${tilesetName}] getNode(${nodeName}) failed:`,
            e,
          );
        }
      }
      const current = subNodesRef.current[tilesetName] ?? [];
      const updated = current.map((n) =>
        n.name === nodeName ? {...n, visible} : n,
      );
      subNodesRef.current = {...subNodesRef.current, [tilesetName]: updated};
      setSubNodes(subNodesRef.current);

      const entry = tilesets.find((t) => t.name === tilesetName);
      if (entry) refreshSubNodeBbox(entry, updated);
    },
    [tilesets, refreshSubNodeBbox],
  );

  /** Update face colors for a tileset, applying immediately if loaded. */
  const setTilesetColors = useCallback(
    (name: string, top: string, bottom: string) => {
      const updated = {...tilesetColorsRef.current, [name]: {top, bottom}};
      tilesetColorsRef.current = updated;
      setTilesetColorsState(updated);
      const ts = tilesetRefs.current[name];
      if (ts) {
        ts.customShader = buildFaceColorShader(top, bottom);
      }
    },
    [],
  );

  const toggleTileset = useCallback(
    (name: string) => {
      if (!viewer || viewer.isDestroyed()) return;

      // Find the entry to determine the next visibility state
      const entry = tilesets.find((t) => t.name === name);
      if (!entry) return;
      const next = !entry.visible;

      setTilesets((prev) =>
        prev.map((t) => (t.name === name ? {...t, visible: next} : t)),
      );

      // Tilesets contribute their authored WGS84 extent to the project
      // bbox while visible, so zoomToFit frames them alongside data.
      if (entry._extent_wgs84) {
        setLayerBbox(tilesetBboxKey(name), next ? entry._extent_wgs84 : null);
      }

      const fullUrl = `${BASE_URL}${entry.url}`;

      // Metadata-carrying GLBs load as a Model — Cesium3DTileset.fromUrl
      // only accepts a tileset.json. Models support EXT_structural_metadata
      // and EXT_mesh_features natively and yield ModelFeature picks.
      if (entry.hasFeatureMetadata) {
        if (next) {
          if (!modelRefs.current[name]) {
            loadGlbSafe(fullUrl)
              .then((buf) => {
                // Wrap the patched ArrayBuffer in a blob URL so we can pass
                // it to Model.fromGltfAsync, which only accepts a URL string.
                // The blob is revoked once the promise settles.
                const blob = new Blob([buf], {type: 'model/gltf-binary'});
                const blobUrl = URL.createObjectURL(blob);
                return Model.fromGltfAsync({url: blobUrl, backFaceCulling: false})
                  .finally(() => URL.revokeObjectURL(blobUrl));
              })
              .then((model) => {
                tilesetNameByInstance.set(model, name);
                modelRefs.current[name] = model;
                viewer.scene.primitives.add(model);
                console.log(`[tileset:${name}] loaded (model)`);

                // Discover sub-nodes once the scene graph is built.
                // readyEvent fires after Model.fromGltfAsync resolves, so
                // we attach a listener and wait for the actual frame
                // where _runtimeNodes is populated.
                const populate = () => {
                  const discovered = discoverSubNodes(model);
                  console.log(
                    `[tileset:${name}] discovered ${discovered.length} sub-node(s)` +
                      (discovered.length > 0
                        ? `: ${discovered.map((n) => n.name).join(', ')}`
                        : ''),
                  );
                  if (discovered.length === 0) return;
                  subNodesRef.current = {
                    ...subNodesRef.current,
                    [name]: discovered,
                  };
                  setSubNodes(subNodesRef.current);
                };
                if (model.ready) populate();
                else model.readyEvent.addEventListener(populate);
              })
              .catch((err) =>
                console.error(`[tileset:${name}] failed:`, err),
              );
          } else {
            modelRefs.current[name].show = true;
          }
        } else if (modelRefs.current[name]) {
          modelRefs.current[name].show = false;
        }
        return;
      }

      // Default path: Cesium3DTileset for tileset.json roots. Gets the
      // top/bottom face-color shader and participates in clipping sync.
      if (next) {
        if (!tilesetRefs.current[name]) {
          Cesium3DTileset.fromUrl(fullUrl)
            .then((ts) => {
              ts.backFaceCulling = false;

              const colors = tilesetColorsRef.current[name] ?? {
                top: DEFAULT_TOP_COLOR,
                bottom: DEFAULT_BOTTOM_COLOR,
              };
              ts.customShader = buildFaceColorShader(
                colors.top,
                colors.bottom,
              );

              tilesetNameByInstance.set(ts, name);
              tilesetRefs.current[name] = ts;
              viewer.scene.primitives.add(ts);

              // Apply current clipping plane (if any) to this freshly
              // loaded tileset — mode-aware so it matches the current
              // toggle state (front/back/thick-slice).
              if (crossSectionPoints) {
                const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
                const {normal, distance} = planeFromPoints(
                  lon1,
                  lat1,
                  lon2,
                  lat2,
                );
                applyClippingToTileset(
                  ts,
                  normal,
                  distance,
                  crossSectionMode,
                  sliceThicknessM,
                );
              }
              console.log(`[tileset:${name}] loaded`);
            })
            .catch((err) =>
              console.error(`[tileset:${name}] failed:`, err),
            );
        } else {
          tilesetRefs.current[name].show = true;
        }
      } else if (tilesetRefs.current[name]) {
        tilesetRefs.current[name].show = false;
      }
    },
    [tilesets, viewer, crossSectionPoints, crossSectionMode, sliceThicknessM],
  );

  return {
    tilesets,
    tilesetRefs,
    toggleTileset,
    tilesetColors,
    setTilesetColors,
    subNodes,
    setSubNodeVisible,
  };
}
