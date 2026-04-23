/**
 * Minimum curvature desurvey — convert deviation survey stations
 * (measured_depth, dip, azimuth) into 3D trajectories.
 *
 * Ported from wellpathpy (https://github.com/Zabamund/wellpathpy).
 *
 * The algorithm computes cumulative (northing, easting, TVD) offsets
 * from the collar at each survey station. Between stations, positions
 * are interpolated along the minimum-curvature arc. The result is a
 * smooth 3D path that can be sampled at any measured depth.
 *
 * ## Coordinate conventions
 *
 * - Input dip: degrees from horizontal, negative = downward.
 *   dip = -90 is vertical down, dip = 0 is horizontal.
 *   Converted internally to inclination from vertical:
 *   inc = π/2 + dip_rad (so inc = 0 = vertical down).
 *
 * - Input azimuth: degrees clockwise from true north.
 *   Assumed to be true north — no grid convergence correction.
 *
 * - Output offsets: meters from collar. Northing = +Y (north),
 *   Easting = +X (east), TVD = depth below collar (positive down).
 *
 * - Conversion to (lon, lat, alt): uses the collar as origin with
 *   a spherical-earth approximation. dLat = dN / R, dLon = dE /
 *   (R * cos(collarLat)). R = mean Earth radius. Accurate to ~1m
 *   for offsets < ~10km from the collar, which is far beyond any
 *   realistic borehole lateral displacement.
 *
 * ## Chunk generation for rendering
 *
 * Sample intervals are split into ≤1ft (0.3048m) chunks so the
 * visual curve is smooth for deviated wells. Each chunk has a
 * midpoint position and a heading-pitch-roll orientation derived
 * from the local tangent to the trajectory. Clicking any chunk
 * highlights all chunks of the same sample interval (not the
 * whole borehole).
 */

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/** A raw survey station as stored in the downhole_survey table. */
export interface RawSurveyStation {
  depth: number;    // measured depth (meters)
  dip: number;      // degrees from horizontal, negative = downward
  azimuth: number;  // degrees clockwise from true north
}

/** A station with inclination converted to radians from vertical. */
interface StationRad {
  md: number;
  inc: number;  // radians, 0 = vertical down
  azi: number;  // radians, 0 = north
}

/** Cumulative offsets from the collar at a given measured depth. */
export interface TrajectoryStation {
  md: number;
  northing: number;  // meters, positive = north
  easting: number;   // meters, positive = east
  tvd: number;       // meters, positive = deeper
}

/** A point along the trajectory in geographic coordinates. */
export interface GeoPosition {
  lon: number;
  lat: number;
  alt: number;  // ellipsoidal altitude (meters)
}

/** A single rendering chunk — position + orientation for one
 * short cylinder segment. */
export interface RenderChunk {
  position: GeoPosition;  // midpoint of the chunk
  length: number;         // chunk length along the trajectory (meters)
  heading: number;        // radians, from north clockwise
  pitch: number;          // radians, 0 = horizontal, negative = downward
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
/** Mean Earth radius (WGS84), meters. */
const R_EARTH = 6_371_000;
/** Maximum chunk length for smooth visual curves. */
const MAX_CHUNK_M = 0.3048; // 1 foot

// ─────────────────────────────────────────────────────────────────
// Core algorithm: minimum curvature
// ─────────────────────────────────────────────────────────────────

/**
 * Convert raw survey stations to the internal radians format.
 * Sorts by measured depth. Adds a collar station at md=0 if not
 * present (vertical, pointing straight down).
 */
function prepareStations(raw: RawSurveyStation[]): StationRad[] {
  const sorted = [...raw].sort((a, b) => a.depth - b.depth);
  const stations: StationRad[] = sorted.map((s) => ({
    md: s.depth,
    // inclination from vertical: inc = 90° + dip
    // dip = -90 → inc = 0 (vertical down)
    // dip = 0   → inc = π/2 (horizontal)
    inc: (90 + s.dip) * DEG,
    azi: s.azimuth * DEG,
  }));
  // Ensure a collar station at md=0 (vertical if not surveyed)
  if (stations.length === 0 || stations[0]!.md > 0) {
    const collarInc = stations.length > 0 ? stations[0]!.inc : 0;
    const collarAzi = stations.length > 0 ? stations[0]!.azi : 0;
    stations.unshift({md: 0, inc: collarInc, azi: collarAzi});
  }
  return stations;
}

/**
 * Direction vector from inclination + azimuth (radians).
 * Returns [northing, easting, vertical_down] components.
 * Convention: inc=0 is vertical down → vertical component = cos(0) = 1.
 */
function directionVector(inc: number, azi: number): [number, number, number] {
  return [
    Math.sin(inc) * Math.cos(azi), // northing
    Math.sin(inc) * Math.sin(azi), // easting
    Math.cos(inc),                 // vertical (down)
  ];
}

/**
 * Angle between two unit direction vectors — numerically stable
 * formulation using atan2(||v-u||, ||v+u||) × 2. Better than
 * acos(dot) for nearly-parallel vectors (straight segments).
 *
 * Ported from wellpathpy/geometry.py angle_between.
 */
function angleBetween(
  u: [number, number, number],
  v: [number, number, number],
): number {
  const dx = v[0] - u[0];
  const dy = v[1] - u[1];
  const dz = v[2] - u[2];
  const sx = v[0] + u[0];
  const sy = v[1] + u[1];
  const sz = v[2] + u[2];
  const normSub = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const normAdd = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (normAdd === 0) return Math.PI; // antiparallel
  return 2 * Math.atan2(normSub, normAdd);
}

/**
 * Run the minimum curvature algorithm on prepared stations.
 * Returns cumulative (northing, easting, tvd) at each station.
 *
 * Ported from wellpathpy/mincurve.py minimum_curvature_inner.
 */
export function minimumCurvature(
  raw: RawSurveyStation[],
): TrajectoryStation[] {
  if (raw.length === 0) return [];
  const stations = prepareStations(raw);
  if (stations.length === 1) {
    return [{md: stations[0]!.md, northing: 0, easting: 0, tvd: 0}];
  }

  const result: TrajectoryStation[] = [
    {md: stations[0]!.md, northing: 0, easting: 0, tvd: 0},
  ];

  let cumN = 0;
  let cumE = 0;
  let cumTVD = 0;

  for (let i = 1; i < stations.length; i++) {
    const prev = stations[i - 1]!;
    const curr = stations[i]!;
    const mdDiff = curr.md - prev.md;
    if (mdDiff <= 0) continue;

    const dvPrev = directionVector(prev.inc, prev.azi);
    const dvCurr = directionVector(curr.inc, curr.azi);
    const dogleg = angleBetween(dvPrev, dvCurr);

    // Ratio factor — handles the straight-segment limit (dogleg → 0)
    let rf: number;
    if (Math.abs(dogleg) < 1e-10) {
      rf = 1;
    } else {
      rf = (2 / dogleg) * Math.tan(dogleg / 2);
    }

    const halfMd = mdDiff / 2;
    cumN += halfMd * (dvPrev[0] + dvCurr[0]) * rf;
    cumE += halfMd * (dvPrev[1] + dvCurr[1]) * rf;
    cumTVD += halfMd * (dvPrev[2] + dvCurr[2]) * rf;

    result.push({md: curr.md, northing: cumN, easting: cumE, tvd: cumTVD});
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// Trajectory interpolation
// ─────────────────────────────────────────────────────────────────

/**
 * Interpolate the trajectory at an arbitrary measured depth.
 * Returns (northing, easting, tvd) at that depth via linear
 * interpolation between the bracketing survey stations.
 *
 * Also returns the local tangent direction (dN/dMD, dE/dMD,
 * dTVD/dMD) for computing the cylinder orientation.
 */
export function interpolateAtDepth(
  trajectory: TrajectoryStation[],
  md: number,
): {
  northing: number;
  easting: number;
  tvd: number;
  tangentN: number;
  tangentE: number;
  tangentTVD: number;
} {
  if (trajectory.length === 0) {
    return {northing: 0, easting: 0, tvd: 0, tangentN: 0, tangentE: 0, tangentTVD: 1};
  }
  // Clamp to trajectory bounds
  if (md <= trajectory[0]!.md) {
    const t = trajectory.length > 1 ? trajectory[1]! : trajectory[0]!;
    const prev = trajectory[0]!;
    const segLen = t.md - prev.md || 1;
    return {
      ...prev,
      tangentN: (t.northing - prev.northing) / segLen,
      tangentE: (t.easting - prev.easting) / segLen,
      tangentTVD: (t.tvd - prev.tvd) / segLen,
    };
  }
  const last = trajectory[trajectory.length - 1]!;
  if (md >= last.md) {
    const prev = trajectory.length > 1 ? trajectory[trajectory.length - 2]! : last;
    const segLen = last.md - prev.md || 1;
    return {
      northing: last.northing,
      easting: last.easting,
      tvd: last.tvd,
      tangentN: (last.northing - prev.northing) / segLen,
      tangentE: (last.easting - prev.easting) / segLen,
      tangentTVD: (last.tvd - prev.tvd) / segLen,
    };
  }

  // Find bracketing stations
  let lo = 0;
  for (let i = 1; i < trajectory.length; i++) {
    if (trajectory[i]!.md >= md) {
      lo = i - 1;
      break;
    }
  }
  const a = trajectory[lo]!;
  const b = trajectory[lo + 1]!;
  const segLen = b.md - a.md;
  const t = segLen > 0 ? (md - a.md) / segLen : 0;

  const northing = a.northing + t * (b.northing - a.northing);
  const easting = a.easting + t * (b.easting - a.easting);
  const tvd = a.tvd + t * (b.tvd - a.tvd);
  const tangentN = (b.northing - a.northing) / segLen;
  const tangentE = (b.easting - a.easting) / segLen;
  const tangentTVD = (b.tvd - a.tvd) / segLen;

  return {northing, easting, tvd, tangentN, tangentE, tangentTVD};
}

// ─────────────────────────────────────────────────────────────────
// Coordinate conversion
// ─────────────────────────────────────────────────────────────────

/**
 * Convert a (northing, easting, tvd) offset from the collar into
 * a geographic position (lon, lat, alt).
 *
 * Uses spherical-earth approximation:
 *   dLat = dN / R_EARTH  (radians)
 *   dLon = dE / (R_EARTH * cos(collarLat))  (radians)
 *   alt  = collarAlt - tvd
 *
 * Accurate to ~1m for offsets up to ~10km, which is far beyond
 * any realistic borehole lateral displacement.
 */
export function offsetToGeo(
  collarLon: number,
  collarLat: number,
  collarAlt: number,
  northing: number,
  easting: number,
  tvd: number,
): GeoPosition {
  const cosLat = Math.cos(collarLat * DEG);
  return {
    lat: collarLat + (northing / R_EARTH) / DEG,
    lon: collarLon + (easting / (R_EARTH * cosLat)) / DEG,
    alt: collarAlt - tvd,
  };
}

// ─────────────────────────────────────────────────────────────────
// Tangent → heading/pitch conversion
// ─────────────────────────────────────────────────────────────────

/**
 * Convert a local tangent vector (dN, dE, dTVD per unit MD) into
 * (heading, pitch) for Cesium's HeadingPitchRoll.
 *
 * - heading: radians clockwise from north (atan2(dE, dN))
 * - pitch: radians from horizontal, negative = downward
 *   For CylinderGeometry whose axis is local "up", the pitch
 *   is actually the tilt from vertical:
 *   pitch = -(π/2 - acos(dTVD / |tangent|))
 *   which simplifies to: pitch = asin(dTVD / |tangent|) - π/2
 *
 * For a vertical segment (dN≈0, dE≈0, dTVD≈1): heading=0, pitch=0
 * (cylinder axis = up = vertical). Correct.
 *
 * For a horizontal segment heading north (dN≈1, dE≈0, dTVD≈0):
 * heading=0, pitch=-π/2. The cylinder tilts 90° from vertical
 * toward north.
 */
export function tangentToHPR(
  tangentN: number,
  tangentE: number,
  tangentTVD: number,
): {heading: number; pitch: number} {
  const mag = Math.sqrt(tangentN ** 2 + tangentE ** 2 + tangentTVD ** 2);
  if (mag < 1e-10) return {heading: 0, pitch: 0};

  // Heading: direction in the horizontal plane
  const heading = Math.atan2(tangentE, tangentN);

  // Pitch: angle from vertical. CylinderGeometry axis = up.
  // When tangent is purely vertical (TVD component dominates),
  // pitch should be 0 (cylinder already vertical).
  // asin(TVD/mag) gives the angle from horizontal;
  // subtract from π/2 to get angle from vertical, then negate
  // because Cesium pitch is positive = tilt up from horizontal.
  const incFromVert = Math.acos(Math.min(1, Math.max(-1, tangentTVD / mag)));
  // For CylinderGeometry: pitch=0 means axis=up (vertical).
  // incFromVert=0 (vertical) → pitch=0. ✓
  // incFromVert=π/2 (horizontal) → pitch=-π/2. ✓
  const pitch = -incFromVert;

  return {heading, pitch};
}

// ─────────────────────────────────────────────────────────────────
// Chunk generation
// ─────────────────────────────────────────────────────────────────

/**
 * Split a sample interval into ≤1ft rendering chunks along the
 * desurvey trajectory. Each chunk gets a position (lon/lat/alt)
 * and orientation (heading/pitch) for a CylinderGeometry.
 *
 * @param trajectory  Pre-computed minimum curvature stations
 * @param collarLon   Collar longitude (WGS84 degrees)
 * @param collarLat   Collar latitude (WGS84 degrees)
 * @param collarAlt   Collar ellipsoidal altitude (meters)
 * @param topDepthM   Top of sample interval (measured depth, meters)
 * @param bottomDepthM Bottom of sample interval (measured depth, meters)
 * @param maxChunkM   Max chunk length (default 1ft = 0.3048m)
 */
export function generateChunks(
  trajectory: TrajectoryStation[],
  collarLon: number,
  collarLat: number,
  collarAlt: number,
  topDepthM: number,
  bottomDepthM: number,
  maxChunkM: number = MAX_CHUNK_M,
): RenderChunk[] {
  const intervalLength = Math.abs(bottomDepthM - topDepthM);
  if (intervalLength < 1e-6) return [];

  const nChunks = Math.max(1, Math.ceil(intervalLength / maxChunkM));
  const chunkLen = intervalLength / nChunks;
  const chunks: RenderChunk[] = [];

  for (let i = 0; i < nChunks; i++) {
    const chunkTopMD = topDepthM + i * chunkLen;
    const chunkMidMD = chunkTopMD + chunkLen / 2;

    const interp = interpolateAtDepth(trajectory, chunkMidMD);
    const position = offsetToGeo(
      collarLon,
      collarLat,
      collarAlt,
      interp.northing,
      interp.easting,
      interp.tvd,
    );
    const {heading, pitch} = tangentToHPR(
      interp.tangentN,
      interp.tangentE,
      interp.tangentTVD,
    );

    chunks.push({position, length: chunkLen, heading, pitch});
  }

  return chunks;
}

/**
 * Convenience: generate chunks for a vertical borehole (no survey
 * data). Equivalent to the old fabricateTrajectory but produces
 * chunks for smooth rendering.
 */
export function generateVerticalChunks(
  collarLon: number,
  collarLat: number,
  collarAlt: number,
  topDepthM: number,
  bottomDepthM: number,
  maxChunkM: number = MAX_CHUNK_M,
): RenderChunk[] {
  // Vertical well: two stations (collar + deep) pointing down.
  // The deep station needs to be at or beyond bottomDepthM so
  // interpolation covers the full interval.
  const maxDepth = Math.max(bottomDepthM, topDepthM) + 1;
  const trajectory = minimumCurvature([
    {depth: 0, dip: -90, azimuth: 0},
    {depth: maxDepth, dip: -90, azimuth: 0},
  ]);
  return generateChunks(
    trajectory,
    collarLon,
    collarLat,
    collarAlt,
    topDepthM,
    bottomDepthM,
    maxChunkM,
  );
}
