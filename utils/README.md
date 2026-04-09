# utils — chemrooms tooling

Standalone Python helpers that aren't part of the FastAPI server. Each
script runs in its own `uv`-managed environment and is invoked with
`uv run`, so you don't need to manage venvs by hand.

## tif_to_glb.py — GeoTIFF DEM → Cesium 3D Tileset

Converts a GeoTIFF DEM into a Cesium-compatible 3D Tileset (a `tileset.json`
plus a `terrain.glb` mesh). The mesh is rendered by Cesium as a
`Cesium3DTileset` overlay — a real glTF mesh, not quantized-mesh terrain
tiles. This avoids the tile-edge seam artifacts that show up with
vertical exaggeration on quantized terrain.

### Input requirements

The input GeoTIFF **must** be in `EPSG:4979` — WGS84 lon/lat in degrees,
with **ellipsoidal heights in meters**. If your DEM is in a different
CRS (e.g. a local State Plane + NAVD88 compound CRS like `EPSG:5498`),
**reproject in QGIS first**: pick `Raster → Projections → Warp (Reproject)`
and set the target CRS to `EPSG:4979`. QGIS uses PROJ under the hood and
will apply the geoid correction automatically — provided the appropriate
geoid grid files are installed (QGIS will offer to download them on first
use). The script does not do any vertical-datum work itself, so QGIS is
the source of truth for any datum shift.

### Where to put the output

Tilesets are static assets served by the SPA. Each tileset lives in its
own subdirectory under `client/public/tiles/<name>/`, containing a
`tileset.json` and a `terrain.glb`. Each subdirectory becomes one
toggleable layer in the Layers menu.

```bash
# from the repo root
uv run --project utils/ utils/tif_to_glb.py path/to/dem.tif \
  -o client/public/tiles/mysite/
```

The script writes the mesh in glTF Y-up with axis mapping
`(East, Up, -North)` and a tileset `transform` matrix that places the
local frame onto the WGS84 ellipsoid via ENU→ECEF.

### Other flags

- `--reduction <0.0–0.99>` — quadric edge collapse decimation. Removes
  the given fraction of triangles using a curvature-aware metric, so
  flat areas are aggressively decimated while ridges, cliffs, and other
  detailed regions retain their resolution. Example: `--reduction 0.9`
  keeps roughly 10% of the original triangle count.

### After generating tiles

The Layers menu reads `client/public/tiles/manifest.json` to discover
which tilesets exist. The manifest is regenerated automatically by
`npm run dev` and `npm run build`, but you can also rebuild it on demand:

```bash
cd client
npm run tiles-manifest
```

This is just a node script (`client/scripts/build-tiles-manifest.mjs`)
that scans `public/tiles/` for subdirectories containing a `tileset.json`
and writes the manifest. Run it any time you add, remove, or rename a
tileset directory while the dev server is running, then refresh the
browser.
