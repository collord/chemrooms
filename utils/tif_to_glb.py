"""
Convert a GeoTIFF DEM to a Cesium 3D Tileset (tileset.json + terrain.glb).

Input must be in EPSG:4979 (WGS84 lon/lat + ellipsoidal height in meters).
Use QGIS to reproject from other CRSs (e.g. EPSG:5498 → EPSG:4979)
before running this script — QGIS/PROJ handles datum and geoid corrections.

The mesh is written in a local East-North-Up frame centered on the DEM,
mapped into glTF Y-up via (East, Up, -North) so that Cesium's internal
Y-up→Z-up rotation lands it back in ENU. The tileset.json transform then
places the local frame correctly in ECEF on the WGS84 ellipsoid.

Usage:
    python tif_to_glb.py input.tif -o client/public/tiles/mysite/
    python tif_to_glb.py input.tif -o client/public/tiles/mysite/ --reduction 0.9
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pyvista as pv
import rasterio
import trimesh

# WGS84 ellipsoid constants
WGS84_A = 6378137.0
WGS84_E2 = 6.6943799901377997e-3

# Tan/terrain color (RGBA) for the mesh
MESH_COLOR = [180, 160, 120, 255]


def enu_to_gltf(enu_x, enu_y, enu_z):
    """
    Convert ENU (East, North, Up) to glTF Y-up (East, Up, -North).
    Cesium applies its internal Y-up→Z-up: (X, Y, Z) → (X, Z, -Y),
    which sends (East, Up, -North) → (East, North, Up) = ENU.
    The tile transform then maps ENU → ECEF.
    """
    return enu_x, enu_z, -enu_y


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


def load_dem(path: str):
    with rasterio.open(path) as src:
        dem = src.read(1)
        nodata = src.nodata
        transform = src.transform
        crs = src.crs

    epsg = crs.to_epsg() if crs else None
    if epsg and epsg != 4979:
        print(f"  WARNING: CRS is EPSG:{epsg}, expected EPSG:4979.")
        print(f"  Reproject in QGIS first.")

    rows, cols = dem.shape
    row_idx, col_idx = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    xs, ys = rasterio.transform.xy(transform, row_idx.ravel(), col_idx.ravel(), offset="center")
    lons = np.array(xs, dtype=np.float64)
    lats = np.array(ys, dtype=np.float64)
    heights = dem.ravel().astype(np.float64)
    valid = (heights != nodata) if nodata is not None else np.isfinite(heights)
    return lons, lats, heights, valid, rows, cols


def quadric_decimate(vertices, faces, reduction):
    """
    Quadric edge collapse decimation via PyVista/VTK.
    `reduction` is the fraction of triangles to remove (0.0–0.99).
    Curved/detailed regions retain more vertices than flat areas.
    """
    # PyVista expects faces in [N, v0, v1, v2, N, v0, v1, v2, ...] format
    n_faces = len(faces)
    pv_faces = np.empty((n_faces, 4), dtype=np.int64)
    pv_faces[:, 0] = 3
    pv_faces[:, 1:] = faces
    pv_mesh = pv.PolyData(vertices, pv_faces.ravel())

    decimated = pv_mesh.decimate(reduction)

    new_verts = np.asarray(decimated.points, dtype=np.float64)
    # Pull triangles back out — every face has the leading "3"
    raw = np.asarray(decimated.faces).reshape(-1, 4)
    new_faces = raw[:, 1:].astype(np.int32)
    return new_verts, new_faces


def build_mesh(local_x, local_y, local_z, valid, rows, cols, color_rgba, reduction=0.0):
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

    if reduction > 0.0:
        before = len(faces)
        vertices, faces = quadric_decimate(vertices, faces, reduction)
        print(f"    decimated {before} → {len(faces)} faces ({reduction:.0%} reduction)")

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


def build_tileset_json(lons, lats, heights, transform_matrix):
    lon_min, lon_max = np.radians(lons.min()), np.radians(lons.max())
    lat_min, lat_max = np.radians(lats.min()), np.radians(lats.max())
    h_min, h_max = float(heights.min()), float(heights.max())
    extent_deg = max(np.degrees(lon_max - lon_min), np.degrees(lat_max - lat_min))
    transform_flat = transform_matrix.T.ravel().tolist()

    return {
        "asset": {"version": "1.0"},
        "geometricError": extent_deg * 111000,
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


def main():
    parser = argparse.ArgumentParser(
        description="Convert GeoTIFF DEM (EPSG:4979) to a Cesium 3D Tileset"
    )
    parser.add_argument("input", help="Input GeoTIFF file (must be EPSG:4979)")
    parser.add_argument(
        "-o", "--output", default=".",
        help="Output directory (will contain tileset.json + terrain.glb)",
    )
    parser.add_argument(
        "--reduction", type=float, default=0.0,
        help="Quadric edge collapse decimation: fraction of triangles to remove "
             "(0.0–0.99). Curvature-aware: flat areas decimate more than detailed ones. "
             "Example: 0.9 keeps ~10%% of faces.",
    )
    args = parser.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    print(f"Reading {args.input}...")
    lons, lats, heights, valid, rows, cols = load_dem(args.input)
    print(f"  Grid: {cols}x{rows} = {len(lons)} vertices ({valid.sum()} valid)")

    center_lon = float((lons.min() + lons.max()) / 2)
    center_lat = float((lats.min() + lats.max()) / 2)
    center_height = float(np.nanmean(heights[valid]))
    print(f"  ENU origin: ({center_lon:.6f}, {center_lat:.6f}, {center_height:.1f}m)")

    print("Converting to ECEF → local ENU → glTF Y-up...")
    ecef_x, ecef_y, ecef_z = lonlat_to_ecef(lons, lats, heights)
    transform_matrix = enu_to_ecef_matrix(center_lon, center_lat, center_height)
    enu_x, enu_y, enu_z = ecef_to_enu(ecef_x, ecef_y, ecef_z, transform_matrix)
    local_x, local_y, local_z = enu_to_gltf(enu_x, enu_y, enu_z)

    print("Building mesh...")
    mesh = build_mesh(local_x, local_y, local_z, valid, rows, cols,
                      MESH_COLOR, reduction=args.reduction)
    print(f"  {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")

    glb_path = out / "terrain.glb"
    mesh.export(str(glb_path))
    size_mb = glb_path.stat().st_size / (1024 * 1024)
    print(f"  Wrote {glb_path} ({size_mb:.1f} MB)")

    tileset = build_tileset_json(lons, lats, heights, transform_matrix)
    (out / "tileset.json").write_text(json.dumps(tileset, indent=2))
    print(f"  Wrote {out / 'tileset.json'}")

    print(f"\nDone. Serve from: {out}/")


if __name__ == "__main__":
    main()
