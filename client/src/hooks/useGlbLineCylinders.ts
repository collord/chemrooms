/**
 * Build Cesium cylinder primitives from LINES primitives in a Leapfrog GLB.
 *
 * Leapfrog exports borehole intervals as glTF LINES primitives. Duplicate
 * node names exist (drillholes + drillholes-trace); we process only the
 * first occurrence of each name. The sidecar .views.json carries per-shape
 * cylinder_radius_m and a placement_matrix_4x4_column_major that transforms
 * local scene coordinates to ECEF.
 */

import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  GeometryInstance,
  HeadingPitchRoll,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  Transforms,
} from 'cesium';
import type {Model, Viewer} from 'cesium';
import {tangentToHPR} from '../layers/desurvey';

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

export async function buildGlbLineCylinders(
  glbUrl: string,
  sidecarUrl: string,
  viewer: Viewer,
  model: Model,
): Promise<Record<string, Primitive>> {
  const [raw, sidecar] = await Promise.all([
    fetch(glbUrl).then((r) => r.arrayBuffer()),
    fetch(sidecarUrl).then((r) => r.json() as Promise<Sidecar>),
  ]);

  const jsonChunkLen = new DataView(raw).getUint32(12, true);
  const gltf = JSON.parse(
    new TextDecoder().decode(new Uint8Array(raw, 20, jsonChunkLen)),
  ) as {
    accessors: Array<{count: number; bufferView: number; byteOffset?: number; componentType: number; type: string}>;
    bufferViews: Array<{byteOffset?: number}>;
    meshes: Array<{primitives: Array<{mode?: number; attributes: {POSITION: number}; indices?: number}>}>;
    nodes: Array<{name?: string; mesh?: number}>;
  };

  const binOffset = 20 + jsonChunkLen + 8;

  const rawMat = sidecar.coordinate_system?.placement_matrix_4x4_column_major;
  const placementMatrix = rawMat
    ? Matrix4.fromColumnMajorArray(rawMat)
    : Matrix4.IDENTITY.clone();

  // Extract the 3×3 rotation part for transforming direction vectors
  // (directions are unaffected by translation).
  const placementRotation = Matrix4.getMatrix3(placementMatrix, new Matrix3());

  const shapeByName = new Map<string, SidecarShape>();
  for (const s of sidecar.shapes) shapeByName.set(s.name, s);

  const added: Record<string, Primitive> = {};
  const processedNames = new Set<string>();

  for (const node of gltf.nodes) {
    if (node.mesh == null || !node.name) continue;

    // Skip duplicate node names — Leapfrog emits drillholes + drillholes-trace
    // as separate nodes with the same name. We only want the first (drillholes).
    if (processedNames.has(node.name)) continue;

    const mesh = gltf.meshes[node.mesh];
    const prim = mesh.primitives[0];
    if ((prim.mode ?? 4) !== 1) continue; // 1 = LINES

    const shape = shapeByName.get(node.name);
    if (!shape?.cylinder_radius_m) continue;

    processedNames.add(node.name);

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

    const instances: GeometryInstance[] = [];
    const segCount = Math.floor(indices.length / 2);

    const localA = new Cartesian3();
    const localB = new Cartesian3();
    const ecefA = new Cartesian3();
    const ecefB = new Cartesian3();
    const mid = new Cartesian3();
    const localDir = new Cartesian3();
    const ecefDir = new Cartesian3();

    for (let si = 0; si < segCount; si++) {
      const iA = indices[si * 2];
      const iB = indices[si * 2 + 1];

      Cartesian3.fromArray(positions as unknown as number[], iA * 3, localA);
      Cartesian3.fromArray(positions as unknown as number[], iB * 3, localB);

      // Transform points to ECEF.
      Matrix4.multiplyByPoint(placementMatrix, localA, ecefA);
      Matrix4.multiplyByPoint(placementMatrix, localB, ecefB);

      const length = Cartesian3.distance(ecefA, ecefB);
      if (length < 0.01) continue;

      Cartesian3.midpoint(ecefA, ecefB, mid);

      // Segment direction in local space → rotate to ECEF (no translation).
      Cartesian3.subtract(localB, localA, localDir);
      Cartesian3.normalize(localDir, localDir);
      Matrix3.multiplyByVector(placementRotation, localDir, ecefDir);
      Cartesian3.normalize(ecefDir, ecefDir);

      // Convert ECEF direction to ENU components at midpoint, then to HPR.
      const enu = Transforms.eastNorthUpToFixedFrame(mid);
      // ENU columns: east=col0, north=col1, up=col2
      const east  = new Cartesian3(enu[0], enu[1], enu[2]);
      const north = new Cartesian3(enu[4], enu[5], enu[6]);
      const up    = new Cartesian3(enu[8], enu[9], enu[10]);

      const dE   = Cartesian3.dot(ecefDir, east);
      const dN   = Cartesian3.dot(ecefDir, north);
      const dTVD = -Cartesian3.dot(ecefDir, up); // TVD positive = downward

      const {heading, pitch} = tangentToHPR(dN, dE, dTVD);
      const hpr = new HeadingPitchRoll(heading, pitch, 0);

      instances.push(
        new GeometryInstance({
          geometry: new CylinderGeometry({
            length,
            topRadius: radius,
            bottomRadius: radius,
            slices: CYLINDER_SLICES,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          modelMatrix: Transforms.headingPitchRollToFixedFrame(mid, hpr),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(colour),
          },
        }),
      );
    }

    if (instances.length === 0) continue;

    try {
      const modelNode = model.getNode(node.name);
      if (modelNode) modelNode.show = false;
    } catch {
      // Not critical if node isn't accessible yet.
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
    added[node.name] = primitive;
  }

  return added;
}
