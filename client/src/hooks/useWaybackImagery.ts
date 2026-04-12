/**
 * ESRI World Imagery Wayback integration.
 *
 * Wayback is a free public service from ESRI providing historical
 * snapshots of World Imagery — roughly one snapshot every few weeks
 * since 2014. The @esri/wayback-core library handles the discovery
 * endpoint and returns a list of WaybackItem records.
 *
 * Each WaybackItem has a URL template like
 *   `.../tile/{releaseNum}/{level}/{row}/{col}`
 * which we substitute the releaseNum into and translate to Cesium's
 * `{z}/{y}/{x}` placeholders for UrlTemplateImageryProvider.
 *
 * The hook:
 *   - On mount, fetches the release list (cached after first call)
 *   - Returns the sorted list, the active release, and a setter
 *   - When the active release changes, swaps the Cesium imagery
 *     layer (removes the old one, adds the new one)
 *   - On unmount or when set to null, cleans up the layer
 *
 * Wayback layers are added on top of Cesium's default Bing imagery.
 * Where Wayback has data (everywhere except the poles), it covers
 * the base layer. Toggling the active release to null removes the
 * Wayback layer and the base imagery is visible again.
 *
 * No authentication required — Wayback is publicly accessible.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {
  ImageryLayer,
  UrlTemplateImageryProvider,
} from 'cesium';
import {getWaybackItems, type WaybackItem} from '@esri/wayback-core';
import {useStoreWithCesium} from '@sqlrooms/cesium';

export function useWaybackImagery() {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);

  const [items, setItems] = useState<WaybackItem[]>([]);
  const [activeReleaseNum, setActiveReleaseNum] = useState<number | null>(
    null,
  );
  const layerRef = useRef<ImageryLayer | null>(null);

  // Fetch the release list once on mount.
  useEffect(() => {
    let cancelled = false;
    getWaybackItems()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        console.log(`[wayback] loaded ${list.length} releases`);
      })
      .catch((e) =>
        console.warn('[wayback] failed to fetch release list:', e),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync the active release to a Cesium imagery layer.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    // Remove any existing wayback layer first.
    if (layerRef.current) {
      try {
        viewer.imageryLayers.remove(layerRef.current, true);
      } catch {
        // Layer may have already been removed (e.g. viewer reset)
      }
      layerRef.current = null;
    }

    if (activeReleaseNum === null) return;

    const item = items.find((i) => i.releaseNum === activeReleaseNum);
    if (!item) return;

    // Translate {level}/{row}/{col} to Cesium's {z}/{y}/{x}.
    const url = item.itemURL
      .replace('{level}', '{z}')
      .replace('{row}', '{y}')
      .replace('{col}', '{x}');

    const provider = new UrlTemplateImageryProvider({
      url,
      maximumLevel: 19,
      credit: 'Imagery © Esri',
    });
    layerRef.current = viewer.imageryLayers.addImageryProvider(provider);
    console.log(
      `[wayback] activated release ${item.releaseDateLabel} (${item.releaseNum})`,
    );
  }, [viewer, activeReleaseNum, items]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return;
      if (layerRef.current) {
        try {
          viewer.imageryLayers.remove(layerRef.current, true);
        } catch {
          // ignore
        }
        layerRef.current = null;
      }
    };
  }, [viewer]);

  const clear = useCallback(() => setActiveReleaseNum(null), []);

  return {
    items,
    activeReleaseNum,
    setActiveReleaseNum,
    clear,
    isActive: activeReleaseNum !== null,
  };
}
