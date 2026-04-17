/**
 * Borehole desurvey — convert measured-depth intervals to 3D
 * trajectories for polylineVolume rendering.
 *
 * ## What this does
 *
 * A borehole sample has a depth interval (top_depth, bottom_depth)
 * measured from the collar along the drill string. The rendering
 * pipeline needs 3D (lon, lat, alt) positions for each endpoint.
 * The translation from measured-depth to 3D depends on the
 * borehole's trajectory:
 *
 * - **Vertical wells (the common case)**: collar position straight
 *   down. The trajectory is trivial — both endpoints share the
 *   collar's (lon, lat) and the altitude is `surface_elev - depth`.
 *   This is the default when no deviation survey is available.
 *
 * - **Deviated wells**: the trajectory curves through 3D space.
 *   A deviation survey records (measured_depth, inclination, azimuth)
 *   stations along the hole. The standard algorithm to interpolate
 *   positions between stations is **minimum curvature** (used by
 *   Leapfrog, DataMine, Vulcan, and most mining/geotech software).
 *
 * ## Current status
 *
 * Only the vertical-default path is implemented. The minimum-
 * curvature function has a real signature and documentation but
 * returns the vertical fallback — it's a stub waiting for:
 *
 *  1. A survey table schema in chemduck (measured_depth,
 *     inclination, azimuth per location_id).
 *  2. A join in buildSamplesLayerSql that attaches survey stations
 *     to each sample interval.
 *  3. The actual algorithm implementation (well-documented in
 *     SPE papers and open-source packages; ~50 lines of trig).
 *
 * The renderer (useChemroomsEntities) calls `fabricateTrajectory`
 * which decides: if deviation data is present in the row, call
 * `desurveySample` (the real algorithm path); otherwise, fabricate
 * a vertical two-point trajectory from the collar position and
 * depth interval.
 */

/**
 * A 3D position in WGS84 degrees + ellipsoidal altitude.
 * The renderer converts these to Cesium Cartesian3 for the
 * polylineVolume positions array.
 */
export interface TrajectoryPoint {
  lon: number;
  lat: number;
  alt: number;
}

/**
 * A deviation survey station — one reading from the gyro/MWD tool.
 * A borehole has N stations; the trajectory between them is
 * interpolated via minimum curvature.
 *
 * Not used yet (the survey table doesn't exist in the current
 * chemduck schema), but the type is here so the function
 * signatures are real.
 */
export interface SurveyStation {
  measuredDepth: number; // meters along the drill string
  inclination: number; // degrees from vertical (0 = straight down)
  azimuth: number; // degrees from north, clockwise
}

/**
 * Fabricate a 3D trajectory for a borehole sample interval.
 *
 * This is the entry point the renderer calls per row. It picks
 * the right desurvey path based on what data is available:
 *
 * - If `surveyStations` is provided and non-empty, use the minimum
 *   curvature algorithm to compute the 3D path between topDepthM
 *   and bottomDepthM.
 * - Otherwise, assume vertical: two points straight down from the
 *   collar position.
 *
 * @param collarLon  Collar longitude (WGS84 degrees)
 * @param collarLat  Collar latitude (WGS84 degrees)
 * @param surfaceElevM Collar elevation (ellipsoidal meters)
 * @param topDepthM  Top of the sample interval (meters below collar)
 * @param bottomDepthM Bottom of the sample interval (meters below collar)
 * @param surveyStations Optional deviation survey. When provided,
 *   the trajectory follows the borehole's actual path. When absent,
 *   the trajectory is vertical.
 */
export function fabricateTrajectory(
  collarLon: number,
  collarLat: number,
  surfaceElevM: number,
  topDepthM: number,
  bottomDepthM: number,
  surveyStations?: SurveyStation[],
): TrajectoryPoint[] {
  if (surveyStations && surveyStations.length > 0) {
    return desurveySample(
      collarLon,
      collarLat,
      surfaceElevM,
      topDepthM,
      bottomDepthM,
      surveyStations,
    );
  }
  // Vertical default: two points straight down from the collar.
  // This is the "assign a single survey point at the collar,
  // pointing vertically down" convention that Leapfrog uses
  // for wells without deviation data.
  return [
    {lon: collarLon, lat: collarLat, alt: surfaceElevM - topDepthM},
    {lon: collarLon, lat: collarLat, alt: surfaceElevM - bottomDepthM},
  ];
}

/**
 * Minimum curvature desurvey.
 *
 * Given a set of deviation survey stations and a depth interval,
 * compute the 3D positions of the interval endpoints along the
 * borehole's actual trajectory.
 *
 * ## Algorithm (stub — returns vertical fallback)
 *
 * The real implementation would:
 *  1. Sort stations by measuredDepth.
 *  2. For each consecutive pair of stations, compute the dogleg
 *     angle: cos(DL) = cos(I2-I1) - sin(I1)*sin(I2)*(1-cos(A2-A1))
 *  3. Compute the ratio factor: RF = 2/DL * tan(DL/2) (with the
 *     DL→0 limit = 1.0 for straight segments).
 *  4. Accumulate (dN, dE, dTVD) increments between stations using
 *     the minimum curvature formulae:
 *       dN = (MD2-MD1)/2 * (sin(I1)*cos(A1) + sin(I2)*cos(A2)) * RF
 *       dE = (MD2-MD1)/2 * (sin(I1)*sin(A1) + sin(I2)*sin(A2)) * RF
 *       dTVD = (MD2-MD1)/2 * (cos(I1) + cos(I2)) * RF
 *  5. Convert accumulated (N, E, TVD) offsets from the collar into
 *     (lon, lat, alt) using the collar as the origin and a local
 *     tangent plane approximation.
 *  6. Interpolate the trajectory at topDepthM and bottomDepthM to
 *     get the two endpoint positions.
 *
 * For now, returns the vertical fallback. Replace this function
 * body with the real algorithm when survey data is available.
 */
export function desurveySample(
  collarLon: number,
  collarLat: number,
  surfaceElevM: number,
  topDepthM: number,
  bottomDepthM: number,
  _surveyStations: SurveyStation[],
): TrajectoryPoint[] {
  // STUB: vertical fallback. Replace with minimum curvature.
  return [
    {lon: collarLon, lat: collarLat, alt: surfaceElevM - topDepthM},
    {lon: collarLon, lat: collarLat, alt: surfaceElevM - bottomDepthM},
  ];
}
