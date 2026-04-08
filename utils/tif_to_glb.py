"""
Convert a GeoTIFF DEM to a 3D Tileset (tileset.json + .glb) for Cesium.

Input must be in EPSG:4979 (WGS84 lon/lat + ellipsoidal height in meters).
Use QGIS to reproject from other CRSs (e.g. EPSG:5498 → EPSG:4979)
before running this script — QGIS/PROJ handles datum and geoid corrections.

Vertices are converted to ECEF Cartesian coordinates so Cesium places
the mesh correctly on the globe.

Usage:
    python tif_to_glb.py input.tif -o ../server/tiles/
    python tif_to_glb.py input.tif -o ../server/tiles/ --decimate 4
"""

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
import trimesh

# WGS84 ellipsoid constants
WGS84_A = 6378137.0  # semi-major axis (m)
WGS84_E2 = 6.6943799901377997e-3  # first eccentricity squared


def lonlat_to_ecef(lons_deg, lats_deg, heights):
    """Convert WGS84 lon/lat/height (degrees, meters) to ECEF XYZ."""
    lons = np.radians(lons_deg)
    lats = np.radians(lats_deg)

    sin_lat = np.sin(lats)
    cos_lat = np.cos(lats)
    sin_lon = np.sin(lons)
    cos_lon = np.cos(lons)

    # Prime vertical radius of curvature
    N = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)

    x = (N + heights) * cos_lat * cos_lon
    y = (N + heights) * cos_lat * sin_lon
    z = (N * (1.0 - WGS84_E2) + heights) * sin_lat

    return x, y, z


def load_dem(path: str, decimate: int = 1):
    """Read a GeoTIFF (EPSG:4979) and return lon, lat, height arrays."""
    with rasterio.open(path) as src:
        dem = src.read(1)
        nodata = src.nodata
        transform = src.transform
        crs = src.crs

    # Validate CRS
    epsg = crs.to_epsg() if crs else None
    if epsg and epsg != 4979:
        print(f"  WARNING: CRS is EPSG:{epsg}, expected EPSG:4979.")
        print(f"  Reproject in QGIS first (e.g. EPSG:{epsg} → EPSG:4979).")

    # Decimate (subsample) to reduce mesh size
    if decimate > 1:
        dem = dem[::decimate, ::decimate]
        # Adjust transform for decimated grid
        transform = rasterio.transform.Affine(
            transform.a * decimate,
            transform.b,
            transform.c,
            transform.d,
            transform.e * decimate,
            transform.f,
        )

    rows, cols = dem.shape
    row_idx, col_idx = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")

    # Map pixel coords to CRS coords (lon, lat for EPSG:4979)
    xs, ys = rasterio.transform.xy(
        transform, row_idx.ravel(), col_idx.ravel(), offset="center"
    )
    lons = np.array(xs, dtype=np.float64)
    lats = np.array(ys, dtype=np.float64)
    heights = dem.ravel().astype(np.float64)

    # Build nodata mask
    if nodata is not None:
        valid = heights != nodata
    else:
        valid = np.isfinite(heights)

    return lons, lats, heights, valid, rows, cols


def build_mesh(x, y, z, valid, rows, cols):
    """Build a triangle mesh from a regular grid of ECEF vertices."""
    vertices = np.column_stack([x, y, z])

    # Build faces from grid connectivity (vectorized)
    r_idx, c_idx = np.meshgrid(
        np.arange(rows - 1), np.arange(cols - 1), indexing="ij"
    )
    r_idx = r_idx.ravel()
    c_idx = c_idx.ravel()

    i00 = r_idx * cols + c_idx
    i10 = (r_idx + 1) * cols + c_idx
    i01 = r_idx * cols + (c_idx + 1)
    i11 = (r_idx + 1) * cols + (c_idx + 1)

    # Triangle 1: i00, i10, i01
    mask1 = valid[i00] & valid[i10] & valid[i01]
    tri1 = np.column_stack([i00[mask1], i10[mask1], i01[mask1]])

    # Triangle 2: i01, i10, i11
    mask2 = valid[i01] & valid[i10] & valid[i11]
    tri2 = np.column_stack([i01[mask2], i10[mask2], i11[mask2]])

    faces = np.vstack([tri1, tri2]).astype(np.int32)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces)
    return mesh


def build_tileset_json(lons, lats, heights):
    """Create a minimal tileset.json with a bounding region."""
    lon_min, lon_max = np.radians(lons.min()), np.radians(lons.max())
    lat_min, lat_max = np.radians(lats.min()), np.radians(lats.max())
    h_min, h_max = float(heights.min()), float(heights.max())

    # Geometric error: rough estimate based on extent
    extent_deg = max(np.degrees(lon_max - lon_min), np.degrees(lat_max - lat_min))
    geometric_error = extent_deg * 111000  # ~meters

    return {
        "asset": {"version": "1.0"},
        "geometricError": geometric_error,
        "_extent_wgs84": {
            "west": float(np.degrees(lon_min)),
            "south": float(np.degrees(lat_min)),
            "east": float(np.degrees(lon_max)),
            "north": float(np.degrees(lat_max)),
            "minHeight": h_min,
            "maxHeight": h_max,
        },
        "root": {
            "boundingVolume": {
                "region": [
                    float(lon_min),
                    float(lat_min),
                    float(lon_max),
                    float(lat_max),
                    h_min,
                    h_max,
                ]
            },
            "geometricError": 0,
            "refine": "ADD",
            "content": {"uri": "terrain.glb"},
        },
    }


def main():
    parser = argparse.ArgumentParser(
        description="Convert GeoTIFF DEM (EPSG:4979) to 3D Tileset for Cesium"
    )
    parser.add_argument("input", help="Input GeoTIFF file (must be EPSG:4979)")
    parser.add_argument(
        "-o", "--output", default=".", help="Output directory (default: current)"
    )
    parser.add_argument(
        "--decimate",
        type=int,
        default=1,
        help="Subsample factor to reduce mesh size (e.g. 2 = half resolution)",
    )
    args = parser.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    print(f"Reading {args.input}...")
    lons, lats, heights, valid, rows, cols = load_dem(args.input, args.decimate)
    print(f"  Grid: {cols}x{rows} = {len(lons)} vertices ({valid.sum()} valid)")

    print("Converting to ECEF...")
    x, y, z = lonlat_to_ecef(lons, lats, heights)

    print("Building mesh...")
    mesh = build_mesh(x, y, z, valid, rows, cols)
    print(f"  {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")

    # Export glb
    glb_path = out / "terrain.glb"
    mesh.export(str(glb_path))
    size_mb = glb_path.stat().st_size / (1024 * 1024)
    print(f"  Wrote {glb_path} ({size_mb:.1f} MB)")

    # Build tileset.json
    print("Building tileset.json...")
    tileset = build_tileset_json(lons, lats, heights)
    tileset_path = out / "tileset.json"
    tileset_path.write_text(json.dumps(tileset, indent=2))
    print(f"  Wrote {tileset_path}")

    print(f"\nDone. Serve from: {out}/")


if __name__ == "__main__":
    main()
