import {describe, it, expect} from 'vitest';
import {ndDisplayFactor, ndHides, normalizeEventAgg, normalizeNdDisplay} from './ndDisplay';
import {errorText, filtersIgnoredNotice} from '../layers/layerNotice';

describe('the non-detect display', () => {
  it('maps each choice to a display factor, the policy to none', () => {
    expect(ndDisplayFactor('policy')).toBeNull();
    expect(ndDisplayFactor('dl')).toBe(1);
    expect(ndDisplayFactor('half_dl')).toBe(0.5);
    expect(ndDisplayFactor('zero')).toBe(0);
    expect(ndDisplayFactor('exclude')).toBeNull();
    expect(ndHides('exclude')).toBe(true);
    expect(ndHides('half_dl')).toBe(false);
  });

  it("reads ChemDuck 0.1's names as their nearest display, the rest as the policy", () => {
    expect(normalizeNdDisplay('half_dl')).toBe('half_dl');
    expect(normalizeNdDisplay('raw')).toBe('policy');
    expect(normalizeNdDisplay(undefined)).toBe('policy');
    expect(normalizeNdDisplay('anything')).toBe('policy');
  });

  it("passes aggregate_points' event choices, and defaults the rest", () => {
    expect(normalizeEventAgg('maximum')).toBe('maximum');
    expect(normalizeEventAgg('mean')).toBe('mean');
    expect(normalizeEventAgg('first')).toBe('most_recent');
  });
});

describe('layer notices', () => {
  it("keeps the message of a DuckDB error, without its class or LINE context", () => {
    const e = new Error(
      "Invalid Input Error: aggregate_points: pH in WS, N, method class field is in more than one unit (NONE: 57, SU: 19073)\n\nLINE 3: ...",
    );
    expect(errorText(e)).toBe(
      'aggregate_points: pH in WS, N, method class field is in more than one unit (NONE: 57, SU: 19073)',
    );
  });

  it('names every filter ChemDuck ignored, once', () => {
    expect(filtersIgnoredNotice([{filters_ignored: ''}, {}])).toBeNull();
    const n = filtersIgnoredNotice([{filters_ignored: 'p_fraction'}, {filters_ignored: 'p_fraction, p_sample_types'}]);
    expect(n?.message).toContain('p_fraction, p_sample_types');
  });
});
