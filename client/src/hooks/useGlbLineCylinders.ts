/**
 * Build Cesium cylinder primitives from LINES primitives in a Leapfrog GLB.
 *
 * Leapfrog exports borehole intervals as glTF LINES primitives. The sidecar
 * .views.json carries per-shape cylinder_radius_m and a
 * placement_matrix_4x4_column_major that transforms local scene coordinates
 * to ECEF. We read the vertex positions and index buffer directly from the
 * GLB binary, apply the placement matrix, and build one CylinderGeometry
 * instance per segment, batched into a single Primitive per shape.
 *
 * The Model's LINES nodes are hidden after the cylinders are added so we
 * don't render both.
 */

import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  GeometryInstance,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  Transforms,
  VertexFormat,
} from 'cesium';
import type {Model, Viewer} from 'cesium';

interface SidecarShape {
  name: string;
  geometry_kinds: string[];
  cylinder_radius_m?: number;
  flat_colour?: [number, number, number];
}

interface Sidecar {
  shapes: SidecarShape[];
  coordinate_system?: {
    placement_matrix_4x4_column_major?: number[];
  };
}

const CYLINDER_SLICES = 8;

/** Read a float32 vec3 accessor from a GLB ArrayBuffer. */
function readVec3Accessor(
  raw: ArrayBuffer,
  binOffset: number,
  accessors: Array<{count: number; bufferView: number; byteOffset?: number}>,
  bufferViews: Array<{byteOffset?: number}>,
  idx: number,
): Float32Array {
  const a = accessors[idx];
  const bv = bufferViews[a.bufferView];
  const off = binOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Float32Array(raw, off, a.count * 3);
}

/** Read a uint16 or uint32 index accessor from a GLB ArrayBuffer. */
function readIndexAccessor(
  raw: ArrayBuffer,
  binOffset: number,
  accessors: Array<{count: number; bufferView: number; byteOffset?: number; componentType: number}>,
  bufferViews: Array<{byteOffset?: number}>,
  idx: number,
): Uint16Array | Uint32Array {
  const a = accessors[idx];
  const bv = bufferViews[a.bufferView];
  const off = binOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (a.componentType === 5123) return new Uint16Array(raw, off, a.count);
  return new Uint32Array(raw, off, a.count);
}

/**
 * Parse a GLB ArrayBuffer and build Cesium cylinder Primitives for each
 * LINES node that has a matching sidecar shape with cylinder_radius_m.
 * Returns the primitives added (caller is responsible for cleanup).
 */
export async function buildGlbLineCylinders(
  glbUrl: string,
  sidecarUrl: string,
  viewer: Viewer,
  model: Model,
): Promise<Primitive[]> {
  const [raw, sidecar] = await Promise.all([
    fetch(glbUrl).then((r) => r.arrayBuffer()),
    fetch(sidecarUrl).then((r) => r.json() as Promise<Sidecar>),
  ]);

  // Parse GLB JSON chunk.
  const jsonChunkLen = new DataView(raw).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 20, jsonChunkLen))) as {
    accessors: Array<{count: number; bufferView: number; byteOffset?: number; componentType: number; type: string}>;
    bufferViews: Array<{byteOffset?: number}>;
    meshes: Array<{primitives: Array<{mode?: number; attributes: {POSITION: number}; indices?: number}>}>;
    nodes: Array<{name?: string; mesh?: number; translation?: [number, number, number]}>;
  };

  const binOffset = 20 + jsonChunkLen + 8; // skip JSON chunk header + BIN chunk header

  // Build placement Matrix4 from sidecar (column-major).
  const rawMat = sidecar.coordinate_system?.placement_matrix_4x4_column_major;
  const placementMatrix = rawMat
    ? Matrix4.fromColumnMajorArray(rawMat)
    : Matrix4.IDENTITY.clone();

  // Index sidecar shapes by name for quick lookup.
  const shapeByName = new Map<string, SidecarShape>();
  for (const s of sidecar.shapes) shapeByName.set(s.name, s);

  const added: Primitive[] = [];

  for (const node of gltf.nodes) {
    if (node.mesh == null || !node.name) continue;
    const mesh = gltf.meshes[node.mesh];

    // Only process the first (drillholes) primitive — skip the trace primitive.
    const prim = mesh.primitives[0];
    if ((prim.mode ?? 4) !== 1) continue; // 1 = LINES

    const shape = shapeByName.get(node.name);
    if (!shape?.cylinder_radius_m) continue;

    const radius = shape.cylinder_radius_m;
    const colour = shape.flat_colour
      ? Color.fromBytes(
          Math.round(shape.flat_colour[0] * 255),
          Math.round(shape.flat_colour[1] * 255),
          Math.round(shape.flat_colour[2] * 255),
        )
      : Color.GRAY;

    if (prim.indices == null) continue;

    const positions = readVec3Accessor(raw, binOffset, gltf.accessors, gltf.bufferViews, prim.attributes.POSITION);
    const indices = readIndexAccessor(raw, binOffset, gltf.accessors, gltf.bufferViews, prim.indices);

    const vertexFormat = VertexFormat.POSITION_ONLY;
    const instances: GeometryInstance[] = [];
    const segCount = Math.floor(indices.length / 2);

    const pA = new Cartesian3();
    const pB = new Cartesian3();
    const mid = new Cartesian3();
    const scratch = new Cartesian3();

    for (let si = 0; si < segCount; si++) {
      const iA = indices[si * 2];
      const iB = indices[si * 2 + 1];

      // Vertex positions in local scene space.
      Cartesian3.fromArray(positions as unknown as number[], iA * 3, pA);
      Cartesian3.fromArray(positions as unknown as number[], iB * 3, pB);

      // Transform to ECEF via placement matrix.
      Matrix4.multiplyByPoint(placementMatrix, pA, pA);
      Matrix4.multiplyByPoint(placementMatrix, pB, pB);

      const length = Cartesian3.distance(pA, pB);
      if (length < 0.01) continue; // degenerate

      Cartesian3.midpoint(pA, pB, mid);

      // Axis direction from A to B.
      Cartesian3.subtract(pB, pA, scratch);
      Cartesian3.normalize(scratch, scratch);

      // Build a modelMatrix oriented along the segment axis.
      // Cesium cylinders are built along the local Z axis, so we need
      // headingPitchRoll relative to ENU at the midpoint.
      // Simpler: use a direct rotation matrix from world Z to segment direction.
      const modelMatrix = buildSegmentMatrix(mid, scratch, length);

      instances.push(
        new GeometryInstance({
          geometry: new CylinderGeometry({
            length,
            topRadius: radius,
            bottomRadius: radius,
            slices: CYLINDER_SLICES,
            vertexFormat,
          }),
          modelMatrix,
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(colour),
          },
        }),
      );
    }

    if (instances.length === 0) continue;

    // Hide the corresponding Model node so we don't render both.
    try {
      const modelNode = model.getNode(node.name);
      if (modelNode) modelNode.show = false;
    } catch {
      // Node may not be accessible yet — not critical.
    }

    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({
        closed: true,
        translucent: false,
      }),
      asynchronous: true,
      releaseGeometryInstances: false,
    });
    viewer.scene.primitives.add(primitive);
    added.push(primitive);
  }

  return added;
}

/**
 * Build a modelMatrix that places a cylinder (Cesium local Z-axis) along
 * `direction` in ECEF, centred at `midpoint`.
 *
 * Cesium's CylinderGeometry is built along +Z in local space. We want it
 * along `direction` in world space. Strategy: use ENU frame at midpoint as
 * the reference, then rotate the local Z onto the segment direction.
 */
function buildSegmentMatrix(
  midpoint: Cartesian3,
  direction: Cartesian3,
  _length: number,
): Matrix4 {
  // ENU frame at midpoint (east, north, up columns → local X, Y, Z).
  const enu = Transforms.eastNorthUpToFixedFrame(midpoint);

  // We need the rotation R such that R * [0,0,1]^T = direction_local,
  // where direction_local = enu^-1 * direction_world.
  // Easier: just construct the 3×3 rotation from the segment axis directly.
  //
  // Local cylinder Z = direction (world). Pick an arbitrary perpendicular
  // for X (use ENU 'east' if not parallel, else 'north').
  const worldZ = direction; // already normalised

  // Extract ENU east (first column of enu matrix) as a candidate 'up' for cross.
  const east = new Cartesian3(enu[0], enu[1], enu[2]);
  let worldX = new Cartesian3();
  Cartesian3.cross(worldZ, east, worldX);
  if (Cartesian3.magnitude(worldX) < 1e-6) {
    const north = new Cartesian3(enu[4], enu[5], enu[6]);
    Cartesian3.cross(worldZ, north, worldX);
  }
  Cartesian3.normalize(worldX, worldX);
  const worldY = Cartesian3.cross(worldZ, worldX, new Cartesian3());
  Cartesian3.normalize(worldY, worldY);

  // Build column-major Matrix4: [X | Y | Z | T]
  return new Matrix4(
    worldX.x, worldY.x, worldZ.x, midpoint.x,
    worldX.y, worldY.y, worldZ.y, midpoint.y,
    worldX.z, worldY.z, worldZ.z, midpoint.z,
    0,         0,         0,        1,
  );
}
