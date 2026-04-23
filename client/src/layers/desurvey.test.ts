/**
 * Tests for the minimum curvature desurvey algorithm.
 *
 * All pure math — no Cesium, no DuckDB, no DOM.
 */

import {describe, it, expect} from 'vitest';
import {
  minimumCurvature,
  interpolateAtDepth,
  offsetToGeo,
  tangentToHPR,
  generateChunks,
  generateVerticalChunks,
  type RawSurveyStation,
} from './desurvey';

const DEG = Math.PI / 180;

describe('minimumCurvature', () => {
  it('vertical well: zero lateral displacement, TVD = MD', () => {
    const stations: RawSurveyStation[] = [
      {depth: 0, dip: -90, azimuth: 0},
      {depth: 50, dip: -90, azimuth: 0},
      {depth: 100, dip: -90, azimuth: 0},
    ];
    const result = minimumCurvature(stations);
    expect(result).toHaveLength(3);
    expect(result[0]!.md).toBe(0);
    expect(result[0]!.northing).toBeCloseTo(0);
    expect(result[0]!.easting).toBeCloseTo(0);
    expect(result[0]!.tvd).toBeCloseTo(0);

    expect(result[2]!.md).toBe(100);
    expect(result[2]!.northing).toBeCloseTo(0, 5);
    expect(result[2]!.easting).toBeCloseTo(0, 5);
    expect(result[2]!.tvd).toBeCloseTo(100, 1);
  });

  it('horizontal well heading north: northing = MD, TVD ≈ 0', () => {
    const stations: RawSurveyStation[] = [
      {depth: 0, dip: 0, azimuth: 0},   // horizontal, north
      {depth: 100, dip: 0, azimuth: 0},
    ];
    const result = minimumCurvature(stations);
    expect(result[1]!.northing).toBeCloseTo(100, 0);
    expect(result[1]!.easting).toBeCloseTo(0, 5);
    expect(result[1]!.tvd).toBeCloseTo(0, 5);
  });

  it('horizontal well heading east: easting = MD, TVD ≈ 0', () => {
    const stations: RawSurveyStation[] = [
      {depth: 0, dip: 0, azimuth: 90},
      {depth: 100, dip: 0, azimuth: 90},
    ];
    const result = minimumCurvature(stations);
    expect(result[1]!.easting).toBeCloseTo(100, 0);
    expect(result[1]!.northing).toBeCloseTo(0, 5);
  });

  it('45-degree inclined well heading north', () => {
    // dip = -45 → inc = 45° from vertical
    const stations: RawSurveyStation[] = [
      {depth: 0, dip: -45, azimuth: 0},
      {depth: 100, dip: -45, azimuth: 0},
    ];
    const result = minimumCurvature(stations);
    // At 45° inclination: TVD = MD * cos(45°), N = MD * sin(45°)
    expect(result[1]!.tvd).toBeCloseTo(100 * Math.cos(45 * DEG), 0);
    expect(result[1]!.northing).toBeCloseTo(100 * Math.sin(45 * DEG), 0);
    expect(result[1]!.easting).toBeCloseTo(0, 5);
  });

  it('curving well: starts vertical, ends horizontal north', () => {
    const stations: RawSurveyStation[] = [
      {depth: 0, dip: -90, azimuth: 0},   // vertical
      {depth: 50, dip: -45, azimuth: 0},   // 45° from vertical
      {depth: 100, dip: 0, azimuth: 0},    // horizontal north
    ];
    const result = minimumCurvature(stations);
    // Should have increasing northing as it curves
    expect(result[1]!.northing).toBeGreaterThan(0);
    expect(result[2]!.northing).toBeGreaterThan(result[1]!.northing);
    // TVD should increase but less than MD (because of lateral displacement)
    expect(result[2]!.tvd).toBeLessThan(100);
    expect(result[2]!.tvd).toBeGreaterThan(0);
  });

  it('adds collar station at md=0 if missing', () => {
    const stations: RawSurveyStation[] = [
      {depth: 50, dip: -90, azimuth: 0},
    ];
    const result = minimumCurvature(stations);
    expect(result).toHaveLength(2);
    expect(result[0]!.md).toBe(0);
  });

  it('handles single station', () => {
    const result = minimumCurvature([{depth: 0, dip: -90, azimuth: 0}]);
    expect(result).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(minimumCurvature([])).toEqual([]);
  });
});

describe('interpolateAtDepth', () => {
  const verticalTrajectory = minimumCurvature([
    {depth: 0, dip: -90, azimuth: 0},
    {depth: 100, dip: -90, azimuth: 0},
  ]);

  it('interpolates at midpoint of a vertical trajectory', () => {
    const interp = interpolateAtDepth(verticalTrajectory, 50);
    expect(interp.tvd).toBeCloseTo(50, 0);
    expect(interp.northing).toBeCloseTo(0, 5);
    expect(interp.easting).toBeCloseTo(0, 5);
  });

  it('tangent of vertical well points downward', () => {
    const interp = interpolateAtDepth(verticalTrajectory, 50);
    // tangentTVD should dominate (pointing down)
    expect(interp.tangentTVD).toBeGreaterThan(0.9);
    expect(Math.abs(interp.tangentN)).toBeLessThan(0.01);
    expect(Math.abs(interp.tangentE)).toBeLessThan(0.01);
  });

  it('clamps to first station for md < 0', () => {
    const interp = interpolateAtDepth(verticalTrajectory, -10);
    expect(interp.tvd).toBeCloseTo(0);
  });

  it('clamps to last station for md > max', () => {
    const interp = interpolateAtDepth(verticalTrajectory, 200);
    expect(interp.tvd).toBeCloseTo(100, 0);
  });
});

describe('offsetToGeo', () => {
  it('zero offset returns collar position', () => {
    const pos = offsetToGeo(-116.0, 41.0, 2500, 0, 0, 0);
    expect(pos.lon).toBeCloseTo(-116.0);
    expect(pos.lat).toBeCloseTo(41.0);
    expect(pos.alt).toBeCloseTo(2500);
  });

  it('100m north shifts latitude by ~0.0009°', () => {
    const pos = offsetToGeo(-116.0, 41.0, 2500, 100, 0, 0);
    const dLat = pos.lat - 41.0;
    // 100m / 6371000m ≈ 1.57e-5 rad ≈ 0.0009°
    expect(dLat).toBeGreaterThan(0.0008);
    expect(dLat).toBeLessThan(0.0010);
    expect(pos.lon).toBeCloseTo(-116.0);
  });

  it('TVD reduces altitude', () => {
    const pos = offsetToGeo(-116.0, 41.0, 2500, 0, 0, 50);
    expect(pos.alt).toBeCloseTo(2450);
  });
});

describe('tangentToHPR', () => {
  it('vertical tangent (0, 0, 1) → heading=0, pitch=0', () => {
    const {heading, pitch} = tangentToHPR(0, 0, 1);
    expect(heading).toBeCloseTo(0);
    expect(pitch).toBeCloseTo(0);
  });

  it('horizontal north (1, 0, 0) → heading=0, pitch=-π/2', () => {
    const {heading, pitch} = tangentToHPR(1, 0, 0);
    expect(heading).toBeCloseTo(0);
    expect(pitch).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('horizontal east (0, 1, 0) → heading=π/2, pitch=-π/2', () => {
    const {heading, pitch} = tangentToHPR(0, 1, 0);
    expect(heading).toBeCloseTo(Math.PI / 2, 2);
    expect(pitch).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('45° inclined north → heading=0, pitch=-π/4', () => {
    const s = Math.SQRT1_2;
    const {heading, pitch} = tangentToHPR(s, 0, s);
    expect(heading).toBeCloseTo(0, 2);
    expect(pitch).toBeCloseTo(-Math.PI / 4, 2);
  });
});

describe('generateChunks', () => {
  const verticalTraj = minimumCurvature([
    {depth: 0, dip: -90, azimuth: 0},
    {depth: 100, dip: -90, azimuth: 0},
  ]);

  it('splits a 3m interval into ~10 chunks (1ft each)', () => {
    const chunks = generateChunks(
      verticalTraj,
      -116, 41, 2500,
      10, 13,  // 3m interval
    );
    expect(chunks.length).toBeGreaterThanOrEqual(9);
    expect(chunks.length).toBeLessThanOrEqual(10);
  });

  it('chunks have decreasing altitude for a vertical well', () => {
    const chunks = generateChunks(
      verticalTraj,
      -116, 41, 2500,
      10, 15,
    );
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.position.alt).toBeLessThan(
        chunks[i - 1]!.position.alt,
      );
    }
  });

  it('vertical chunks have heading≈0 and pitch≈0', () => {
    const chunks = generateChunks(
      verticalTraj,
      -116, 41, 2500,
      10, 15,
    );
    for (const chunk of chunks) {
      expect(Math.abs(chunk.pitch)).toBeLessThan(0.1);
    }
  });

  it('returns empty for zero-length interval', () => {
    expect(
      generateChunks(verticalTraj, -116, 41, 2500, 10, 10),
    ).toHaveLength(0);
  });
});

describe('generateVerticalChunks', () => {
  it('produces chunks for a simple vertical case', () => {
    const chunks = generateVerticalChunks(-116, 41, 2500, 0, 5);
    expect(chunks.length).toBeGreaterThan(10); // 5m / 0.3048m ≈ 16
    expect(chunks[0]!.position.alt).toBeCloseTo(2500, -1);
    const last = chunks[chunks.length - 1]!;
    expect(last.position.alt).toBeLessThan(2496);
  });
});
