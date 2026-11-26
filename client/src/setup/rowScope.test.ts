import {describe, it, expect} from 'vitest';
import {
  compactRowScope,
  DEFAULT_ROW_SCOPE,
  describeRowScope,
  isDefaultRowScope,
  normalizeRowScope,
  rowScopeArgs,
} from './rowScope';

describe('rowScopeArgs', () => {
  it("passes nothing for ChemDuck's defaults", () => {
    expect(rowScopeArgs(DEFAULT_ROW_SCOPE)).toEqual([]);
    expect(rowScopeArgs(null)).toEqual([]);
    expect(isDefaultRowScope(undefined)).toBe(true);
  });

  it('names each filter as ChemDuck takes it', () => {
    expect(
      rowScopeArgs({
        ...DEFAULT_ROW_SCOPE,
        startDate: '2020-01-01',
        endDate: '2021-12-31',
        sampleTypes: ['N', 'FD'],
        reportableOnly: false,
        depthMin: 0,
        depthMax: 2.5,
        depthUnits: 'ft',
        reportedUnits: ['SU'],
      }),
    ).toEqual([
      "p_start_date := DATE '2020-01-01'",
      "p_end_date := DATE '2021-12-31'",
      "p_sample_types := ['N', 'FD']::VARCHAR[]",
      'p_reportable_only := FALSE',
      'p_depth_min := 0',
      'p_depth_max := 2.5',
      "p_depth_units := 'ft'",
      "p_reported_units := ['SU']::VARCHAR[]",
    ]);
  });

  it('keeps [] (every sample type) apart from null (normal samples)', () => {
    expect(rowScopeArgs({...DEFAULT_ROW_SCOPE, sampleTypes: []})).toEqual([
      'p_sample_types := []::VARCHAR[]',
    ]);
  });

  it('sends no depth bound without its unit, and no empty unit list', () => {
    expect(rowScopeArgs({...DEFAULT_ROW_SCOPE, depthMax: 2})).toEqual([]);
    expect(rowScopeArgs({...DEFAULT_ROW_SCOPE, depthUnits: 'm'})).toEqual([]);
    expect(rowScopeArgs({...DEFAULT_ROW_SCOPE, reportedUnits: []})).toEqual([]);
  });

  it('quotes values, never splicing them', () => {
    expect(rowScopeArgs({...DEFAULT_ROW_SCOPE, reportedUnits: ["mg/kg'); DROP TABLE x; --"]})).toEqual([
      "p_reported_units := ['mg/kg''); DROP TABLE x; --']::VARCHAR[]",
    ]);
  });
});

describe('normalizeRowScope', () => {
  it('drops what a link or a stored layer should not send to SQL', () => {
    expect(
      normalizeRowScope({
        startDate: "2020-01-01' OR 1=1",
        depthMin: 'NaN',
        depthMax: Infinity,
        sampleTypes: [1, 2],
        reportableOnly: 'yes',
      }),
    ).toEqual(DEFAULT_ROW_SCOPE);
  });

  it('round-trips through its compact form', () => {
    const s = {...DEFAULT_ROW_SCOPE, endDate: '2022-06-30', depthMax: 2, depthUnits: 'm'};
    const c = compactRowScope(s);
    expect(c).toEqual({endDate: '2022-06-30', depthMax: 2, depthUnits: 'm'});
    expect(normalizeRowScope(JSON.parse(JSON.stringify(c)))).toEqual(s);
    expect(compactRowScope(DEFAULT_ROW_SCOPE)).toBeNull();
  });

  it('says what is in force in one line', () => {
    expect(describeRowScope(null)).toBe('normal samples');
    expect(describeRowScope({...DEFAULT_ROW_SCOPE, depthMax: 2, depthUnits: 'm', reportableOnly: true})).toBe(
      'normal samples · reportable only · depth …–2 m',
    );
  });
});
