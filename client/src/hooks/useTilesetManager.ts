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
  Cartesian3,
  Cesium3DTileset,
  CustomShader,
  Model,
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
    };
  }, [viewer]);

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
            Model.fromGltfAsync({url: fullUrl, backFaceCulling: false})
              .then((model) => {
                tilesetNameByInstance.set(model, name);
                modelRefs.current[name] = model;
                viewer.scene.primitives.add(model);
                console.log(`[tileset:${name}] loaded (model)`);
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

  return {tilesets, tilesetRefs, toggleTileset, tilesetColors, setTilesetColors};
}
