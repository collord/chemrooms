"""
Convert a GeoTIFF DEM to a 3D Tileset (tileset.json + .glb) for Cesium.

Input must be in EPSG:4979 (WGS84 lon/lat + ellipsoidal height in meters).
Use QGIS to reproject from other CRSs (e.g. EPSG:5498 → EPSG:4979)
before running this script — QGIS/PROJ handles datum and geoid corrections.

The glb is written in a local East-North-Up (ENU) coordinate frame centered
on the mesh, and tileset.json includes a transform matrix that places it
in ECEF. This avoids floating-point precision issues with large ECEF values.

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
WGS84_B = 6356752.314245179  # semi-minor axis (m)
WGS84_E2 = 6.6943799901377997e-3  # first eccentricity squared


def lonlat_to_ecef(lons_deg, lats_deg, heights):
    """Convert WGS84 lon/lat/height (degrees, meters) to ECEF XYZ."""
    lons = np.radians(lons_deg)
    lats = np.radians(lats_deg)

    sin_lat = np.sin(lats)
    cos_lat = np.cos(lats)
    sin_lon = np.sin(lons)
    cos_lon = np.cos(lons)

    N = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)

    x = (N + heights) * cos_lat * cos_lon
    y = (N + heights) * cos_lat * sin_lon
    z = (N * (1.0 - WGS84_E2) + heights) * sin_lat

    return x, y, z


def enu_to_ecef_matrix(lon_deg, lat_deg, height):
    """
    Compute the 4x4 ENU-to-ECEF transform matrix for a given origin point.
    Equivalent to Cesium's Transforms.eastNorthUpToFixedFrame().
    """
    lon = np.radians(lon_deg)
    lat = np.radians(lat_deg)

    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    sin_lon = np.sin(lon)
    cos_lon = np.cos(lon)

    # ECEF position of the origin
    N = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)
    ox = (N + height) * cos_lat * cos_lon
    oy = (N + height) * cos_lat * sin_lon
    oz = (N * (1.0 - WGS84_E2) + height) * sin_lat

    # East unit vector
    ex, ey, ez = -sin_lon, cos_lon, 0.0

    # North unit vector
    nx, ny, nz = -sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat

    # Up unit vector
    ux, uy, uz = cos_lat * cos_lon, cos_lat * sin_lon, sin_lat

    # 4x4 column-major matrix: [East, North, Up, Origin]
    # glTF uses Y-up, but Cesium handles that internally for 3D Tiles.
    # We provide ENU (X=East, Y=North, Z=Up) which Cesium expects.
    return np.array([
        [ex, nx, ux, ox],
        [ey, ny, uy, oy],
        [ez, nz, uz, oz],
        [0,  0,  0,  1],
    ], dtype=np.float64)


def ecef_to_enu(ecef_x, ecef_y, ecef_z, transform_matrix):
    """Convert ECEF coordinates to local ENU using the inverse of the transform."""
    inv = np.linalg.inv(transform_matrix)
    ones = np.ones_like(ecef_x)
    ecef = np.vstack([ecef_x, ecef_y, ecef_z, ones])  # (4, N)
    local = inv @ ecef  # (4, N)
    return local[0], local[1], local[2]


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

    xs, ys = rasterio.transform.xy(
        transform, row_idx.ravel(), col_idx.ravel(), offset="center"
    )
    lons = np.array(xs, dtype=np.float64)
    lats = np.array(ys, dtype=np.float64)
    heights = dem.ravel().astype(np.float64)

    if nodata is not None:
        valid = heights != nodata
    else:
        valid = np.isfinite(heights)

    return lons, lats, heights, valid, rows, cols


def build_mesh(local_x, local_y, local_z, valid, rows, cols):
    """Build a triangle mesh from a regular grid of local ENU vertices."""
    vertices = np.column_stack([local_x, local_y, local_z])

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

    mask1 = valid[i00] & valid[i10] & valid[i01]
    tri1 = np.column_stack([i00[mask1], i10[mask1], i01[mask1]])

    mask2 = valid[i01] & valid[i10] & valid[i11]
    tri2 = np.column_stack([i01[mask2], i10[mask2], i11[mask2]])

    faces = np.vstack([tri1, tri2]).astype(np.int32)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)

    # Vertex colors — tan/terrain color
    vertex_colors = np.full((len(vertices), 4), [180, 160, 120, 255], dtype=np.uint8)
    mesh.visual.vertex_colors = vertex_colors

    # Compute vertex normals from face normals (no scipy needed)
    face_normals = np.cross(
        vertices[faces[:, 1]] - vertices[faces[:, 0]],
        vertices[faces[:, 2]] - vertices[faces[:, 0]],
    )
    vertex_normals = np.zeros_like(vertices)
    for i in range(3):
        np.add.at(vertex_normals, faces[:, i], face_normals)
    norms = np.linalg.norm(vertex_normals, axis=1, keepdims=True)
    norms[norms == 0] = 1
    vertex_normals /= norms
    mesh.vertex_normals = vertex_normals

    return mesh


def build_tileset_json(lons, lats, heights, transform_matrix):
    """Create tileset.json with bounding region and ENU-to-ECEF transform."""
    lon_min, lon_max = np.radians(lons.min()), np.radians(lons.max())
    lat_min, lat_max = np.radians(lats.min()), np.radians(lats.max())
    h_min, h_max = float(heights.min()), float(heights.max())

    extent_deg = max(np.degrees(lon_max - lon_min), np.degrees(lat_max - lat_min))
    geometric_error = extent_deg * 111000

    # Vertices are stored in glTF Y-up (East, Up, -North).
    # Cesium converts Y-up→Z-up internally, giving (East, North, Up) = ENU.
    # enu_to_ecef_matrix then correctly maps ENU → ECEF. No fixup needed.
    transform_flat = transform_matrix.T.ravel().tolist()

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
            "transform": transform_flat,
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

    # Compute ENU origin at the center of the DEM
    center_lon = float((lons.min() + lons.max()) / 2)
    center_lat = float((lats.min() + lats.max()) / 2)
    center_height = float(np.nanmean(heights[valid]))
    print(f"  ENU origin: ({center_lon:.6f}, {center_lat:.6f}, {center_height:.1f}m)")

    # Convert all vertices to ECEF, then to local ENU
    print("Converting to ECEF → local ENU...")
    ecef_x, ecef_y, ecef_z = lonlat_to_ecef(lons, lats, heights)
    transform_matrix = enu_to_ecef_matrix(center_lon, center_lat, center_height)
    enu_x, enu_y, enu_z = ecef_to_enu(ecef_x, ecef_y, ecef_z, transform_matrix)

    # Convert ENU (X=East, Y=North, Z=Up) to glTF Y-up.
    # Cesium applies Y-up→Z-up internally: (X,Y,Z) → (X, Z, -Y).
    # We need the result to be ENU (East, North, Up):
    #   X → East  : glTF X = East
    #   Z → North : glTF Z = North
    #  -Y → Up    : glTF Y = -Up
    local_x = enu_x        # East  (glTF X)
    local_y = -enu_z       # -Up   (glTF Y)
    local_z = enu_y        # North (glTF Z)

    print("Building mesh...")
    mesh = build_mesh(local_x, local_y, local_z, valid, rows, cols)
    print(f"  {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")

    # Export glb
    glb_path = out / "terrain.glb"
    mesh.export(str(glb_path))
    size_mb = glb_path.stat().st_size / (1024 * 1024)
    print(f"  Wrote {glb_path} ({size_mb:.1f} MB)")

    # Build tileset.json with transform
    print("Building tileset.json...")
    tileset = build_tileset_json(lons, lats, heights, transform_matrix)
    tileset_path = out / "tileset.json"
    tileset_path.write_text(json.dumps(tileset, indent=2))
    print(f"  Wrote {tileset_path}")

    print(f"\nDone. Serve from: {out}/")


if __name__ == "__main__":
    main()
