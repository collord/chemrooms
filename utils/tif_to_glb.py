"""
Convert a GeoTIFF DEM to 3D Tilesets (tileset.json + .glb) for Cesium.

Input must be in EPSG:4979 (WGS84 lon/lat + ellipsoidal height in meters).
Use QGIS to reproject from other CRSs (e.g. EPSG:5498 → EPSG:4979)
before running this script — QGIS/PROJ handles datum and geoid corrections.

By default produces three rotation variants (red/green/blue) to identify
the correct glTF→Cesium axis mapping. Once the correct variant is known,
use --variant <name> to produce only that one without the debug colors.

Usage:
    python tif_to_glb.py input.tif -o ../server/tiles/
    python tif_to_glb.py input.tif -o ../server/tiles/ --decimate 4
    python tif_to_glb.py input.tif -o ../server/tiles/ --variant green
"""

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
import trimesh

# WGS84 ellipsoid constants
WGS84_A = 6378137.0
WGS84_E2 = 6.6943799901377997e-3

# Three candidate ENU→glTF-Y-up axis mappings to try.
# Cesium's internal Y-up→Z-up conversion is: (X,Y,Z) → (X, Z, -Y)
# Each entry is (label, color_rgba, (x_src, y_src, z_src)) where src is
# one of 'E', 'N', 'U', '-E', '-N', '-U' from ENU components.
VARIANTS = {
    "red":   ([220,  80,  80, 255], ("E", "-U",  "N")),   # current attempt
    "green": ([80,  200,  80, 255], ("E",  "N",  "U")),   # ENU as-is
    "blue":  ([80,  120, 220, 255], ("E",  "U", "-N")),   # first attempt
}


def resolve_axes(enu_x, enu_y, enu_z, spec):
    """Map ENU components to glTF axes according to a spec tuple."""
    src_map = {
        "E": enu_x, "-E": -enu_x,
        "N": enu_y, "-N": -enu_y,
        "U": enu_z, "-U": -enu_z,
    }
    return src_map[spec[0]], src_map[spec[1]], src_map[spec[2]]


def lonlat_to_ecef(lons_deg, lats_deg, heights):
    lons = np.radians(lons_deg)
    lats = np.radians(lats_deg)
    sin_lat, cos_lat = np.sin(lats), np.cos(lats)
    sin_lon, cos_lon = np.sin(lons), np.cos(lons)
    N = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)
    x = (N + heights) * cos_lat * cos_lon
    y = (N + heights) * cos_lat * sin_lon
    z = (N * (1.0 - WGS84_E2) + heights) * sin_lat
    return x, y, z


def enu_to_ecef_matrix(lon_deg, lat_deg, height):
    """4x4 ENU-to-ECEF transform (Cesium's eastNorthUpToFixedFrame)."""
    lon, lat = np.radians(lon_deg), np.radians(lat_deg)
    sin_lat, cos_lat = np.sin(lat), np.cos(lat)
    sin_lon, cos_lon = np.sin(lon), np.cos(lon)
    N = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)
    ox = (N + height) * cos_lat * cos_lon
    oy = (N + height) * cos_lat * sin_lon
    oz = (N * (1.0 - WGS84_E2) + height) * sin_lat
    # East, North, Up column vectors
    ex, ey, ez = -sin_lon, cos_lon, 0.0
    nx, ny, nz = -sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat
    ux, uy, uz = cos_lat * cos_lon, cos_lat * sin_lon, sin_lat
    return np.array([
        [ex, nx, ux, ox],
        [ey, ny, uy, oy],
        [ez, nz, uz, oz],
        [0,  0,  0,  1],
    ], dtype=np.float64)


def ecef_to_enu(ecef_x, ecef_y, ecef_z, transform_matrix):
    inv = np.linalg.inv(transform_matrix)
    ones = np.ones_like(ecef_x)
    ecef = np.vstack([ecef_x, ecef_y, ecef_z, ones])
    local = inv @ ecef
    return local[0], local[1], local[2]


def load_dem(path: str, decimate: int = 1):
    with rasterio.open(path) as src:
        dem = src.read(1)
        nodata = src.nodata
        transform = src.transform
        crs = src.crs

    epsg = crs.to_epsg() if crs else None
    if epsg and epsg != 4979:
        print(f"  WARNING: CRS is EPSG:{epsg}, expected EPSG:4979.")
        print(f"  Reproject in QGIS first.")

    if decimate > 1:
        dem = dem[::decimate, ::decimate]
        transform = rasterio.transform.Affine(
            transform.a * decimate, transform.b, transform.c,
            transform.d, transform.e * decimate, transform.f,
        )

    rows, cols = dem.shape
    row_idx, col_idx = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    xs, ys = rasterio.transform.xy(transform, row_idx.ravel(), col_idx.ravel(), offset="center")
    lons = np.array(xs, dtype=np.float64)
    lats = np.array(ys, dtype=np.float64)
    heights = dem.ravel().astype(np.float64)
    valid = (heights != nodata) if nodata is not None else np.isfinite(heights)
    return lons, lats, heights, valid, rows, cols


def build_mesh(local_x, local_y, local_z, valid, rows, cols, color_rgba):
    vertices = np.column_stack([local_x, local_y, local_z])

    r_idx, c_idx = np.meshgrid(np.arange(rows - 1), np.arange(cols - 1), indexing="ij")
    r_idx, c_idx = r_idx.ravel(), c_idx.ravel()
    i00 = r_idx * cols + c_idx
    i10 = (r_idx + 1) * cols + c_idx
    i01 = r_idx * cols + (c_idx + 1)
    i11 = (r_idx + 1) * cols + (c_idx + 1)

    mask1 = valid[i00] & valid[i10] & valid[i01]
    mask2 = valid[i01] & valid[i10] & valid[i11]
    tri1 = np.column_stack([i00[mask1], i10[mask1], i01[mask1]])
    tri2 = np.column_stack([i01[mask2], i10[mask2], i11[mask2]])
    faces = np.vstack([tri1, tri2]).astype(np.int32)

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.visual.vertex_colors = np.full((len(vertices), 4), color_rgba, dtype=np.uint8)

    # Vertex normals
    face_normals = np.cross(
        vertices[faces[:, 1]] - vertices[faces[:, 0]],
        vertices[faces[:, 2]] - vertices[faces[:, 0]],
    )
    vertex_normals = np.zeros_like(vertices)
    for i in range(3):
        np.add.at(vertex_normals, faces[:, i], face_normals)
    norms = np.linalg.norm(vertex_normals, axis=1, keepdims=True)
    norms[norms == 0] = 1
    mesh.vertex_normals = vertex_normals / norms

    return mesh


def build_tileset_json(lons, lats, heights, transform_matrix, name):
    lon_min, lon_max = np.radians(lons.min()), np.radians(lons.max())
    lat_min, lat_max = np.radians(lats.min()), np.radians(lats.max())
    h_min, h_max = float(heights.min()), float(heights.max())
    extent_deg = max(np.degrees(lon_max - lon_min), np.degrees(lat_max - lat_min))
    transform_flat = transform_matrix.T.ravel().tolist()

    return {
        "asset": {"version": "1.0"},
        "geometricError": extent_deg * 111000,
        "_name": name,
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
                "region": [float(lon_min), float(lat_min), float(lon_max), float(lat_max), h_min, h_max]
            },
            "geometricError": 0,
            "refine": "ADD",
            "content": {"uri": "terrain.glb"},
            "transform": transform_flat,
        },
    }


def write_variant(name, color_rgba, axis_spec, enu_x, enu_y, enu_z,
                  valid, rows, cols, lons, lats, heights, transform_matrix, out):
    variant_dir = out / name
    variant_dir.mkdir(parents=True, exist_ok=True)

    lx, ly, lz = resolve_axes(enu_x, enu_y, enu_z, axis_spec)
    mesh = build_mesh(lx, ly, lz, valid, rows, cols, color_rgba)

    glb_path = variant_dir / "terrain.glb"
    mesh.export(str(glb_path))
    size_mb = glb_path.stat().st_size / (1024 * 1024)
    print(f"  [{name}] {len(mesh.vertices)} verts, {len(mesh.faces)} faces → {size_mb:.1f} MB")

    tileset = build_tileset_json(lons, lats, heights, transform_matrix, name)
    (variant_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))


def main():
    parser = argparse.ArgumentParser(
        description="Convert GeoTIFF DEM (EPSG:4979) to 3D Tileset(s) for Cesium"
    )
    parser.add_argument("input", help="Input GeoTIFF file (must be EPSG:4979)")
    parser.add_argument("-o", "--output", default=".", help="Output directory")
    parser.add_argument("--decimate", type=int, default=1, help="Subsample factor")
    parser.add_argument(
        "--variant", choices=list(VARIANTS.keys()),
        help="Produce only this variant (omit for all three debug variants)",
    )
    args = parser.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    print(f"Reading {args.input}...")
    lons, lats, heights, valid, rows, cols = load_dem(args.input, args.decimate)
    print(f"  Grid: {cols}x{rows} = {len(lons)} vertices ({valid.sum()} valid)")

    center_lon = float((lons.min() + lons.max()) / 2)
    center_lat = float((lats.min() + lats.max()) / 2)
    center_height = float(np.nanmean(heights[valid]))
    print(f"  ENU origin: ({center_lon:.6f}, {center_lat:.6f}, {center_height:.1f}m)")

    print("Converting to ECEF → local ENU...")
    ecef_x, ecef_y, ecef_z = lonlat_to_ecef(lons, lats, heights)
    transform_matrix = enu_to_ecef_matrix(center_lon, center_lat, center_height)
    enu_x, enu_y, enu_z = ecef_to_enu(ecef_x, ecef_y, ecef_z, transform_matrix)

    to_write = {args.variant: VARIANTS[args.variant]} if args.variant else VARIANTS

    print(f"Building {len(to_write)} mesh variant(s)...")
    for name, (color_rgba, axis_spec) in to_write.items():
        write_variant(name, color_rgba, axis_spec, enu_x, enu_y, enu_z,
                      valid, rows, cols, lons, lats, heights, transform_matrix, out)

    print(f"\nDone. Serve from: {out}/")


if __name__ == "__main__":
    main()
