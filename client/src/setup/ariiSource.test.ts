import {describe, it, expect} from 'vitest';
import {
  AriiSourceError,
  checkSidecarsMatch,
  describeFreshness,
  filesLiteral,
  partitionUrl,
  resultsViewSql,
  sha256Prefixed,
  SIDECAR_FORMAT,
  SIDECAR_VERSION,
  type Sidecars,
} from './ariiSource';

const PARTS = [
  {path: 'matrix=WS/fraction=D/part-0000.parquet', rows: 10, as_of: null},
  {path: 'matrix=WS/fraction=T/part-0000.parquet', rows: 5, as_of: null},
];

function sidecars(overrides: Partial<Sidecars['source_manifest']> = {}): Sidecars {
  return {
    format: SIDECAR_FORMAT,
    version: SIDECAR_VERSION,
    generated: '2026-10-16T06:00:00+00:00',
    chemduck: {commit: 'abc', dirty: false},
    source_manifest: {sha256: 'sha256:aa', facility: 'site-a', rows: 15, partitions: PARTS, ...overrides},
    coordinates: {x: 'LONGITUDE', y: 'LATITUDE', crs: 'EPSG:4326', unplaced_locations: 0},
    tables: {},
    results_view: {file: 'sql/results_view.sql', files_token: '/*ARII_FILES*/', rows: 15},
  };
}

describe('partitionUrl', () => {
  it('resolves a partition beside the manifest', () => {
    expect(partitionUrl('https://x.blob.core.windows.net/c/site-a/manifest.json', PARTS[0]!.path)).toBe(
      'https://x.blob.core.windows.net/c/site-a/matrix%3DWS/fraction%3DD/part-0000.parquet',
    );
  });

  it('puts a SAS token after the path, never before it', () => {
    const url = partitionUrl(
      'https://x.blob.core.windows.net/c/site-a/manifest.json?sv=2024&sig=abc%2F',
      PARTS[1]!.path,
    );
    expect(url).toBe(
      'https://x.blob.core.windows.net/c/site-a/matrix%3DWS/fraction%3DT/part-0000.parquet?sv=2024&sig=abc%2F',
    );
  });
});

describe('resultsViewSql', () => {
  it('replaces every token with the registered names, quoted', () => {
    const sql = resultsViewSql(
      "CREATE VIEW results AS SELECT list_position(/*ARII_FILES*/, filename) FROM read_parquet(/*ARII_FILES*/)",
      '/*ARII_FILES*/',
      ["a.parquet", "it's.parquet"],
    );
    expect(sql).not.toContain('/*ARII_FILES*/');
    expect(sql.split(filesLiteral(['a.parquet', "it's.parquet"])).length).toBe(3);
    expect(sql).toContain("'it''s.parquet'");
  });

  it('refuses a template without the token', () => {
    expect(() => resultsViewSql('CREATE VIEW results AS SELECT 1', '/*ARII_FILES*/', [])).toThrow(
      AriiSourceError,
    );
  });
});

describe('checkSidecarsMatch', () => {
  const manifest = {rows: 15, partitions: PARTS.map(({path, rows}) => ({path, rows}))};

  it('accepts the manifest the sidecars were built from', () => {
    expect(() => checkSidecarsMatch(sidecars(), manifest, 'sha256:aa')).not.toThrow();
  });

  it('refuses a republished manifest', () => {
    expect(() => checkSidecarsMatch(sidecars(), manifest, 'sha256:bb')).toThrow(/different manifest/);
  });

  it('refuses partitions listed differently', () => {
    const reordered = {...manifest, partitions: [...manifest.partitions].reverse()};
    expect(() => checkSidecarsMatch(sidecars(), reordered, 'sha256:aa')).toThrow(/different partitions/);
  });

  it('refuses another sidecar format or version', () => {
    expect(() =>
      checkSidecarsMatch({...sidecars(), version: 2}, manifest, 'sha256:aa'),
    ).toThrow(/v1/);
  });
});

describe('sha256Prefixed', () => {
  it('matches the prefixed hex digest the publisher writes', async () => {
    const bytes = new TextEncoder().encode('abc').buffer as ArrayBuffer;
    expect(await sha256Prefixed(bytes)).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('describeFreshness', () => {
  it('says so when no partition records a date', () => {
    expect(describeFreshness(PARTS)).toBe('partition dates not recorded');
  });

  it('shows one date when all partitions agree', () => {
    const parts = PARTS.map((p) => ({...p, as_of: '2026-10-15T03:41:00Z'}));
    expect(describeFreshness(parts)).toBe('as of 2026-10-15');
  });

  it('shows the range and counts undated partitions', () => {
    const parts = [
      {...PARTS[0]!, as_of: '2026-10-14T03:00:00Z'},
      {...PARTS[1]!, as_of: '2026-10-15T03:00:00Z'},
      {path: 'x', rows: 1, as_of: null},
    ];
    expect(describeFreshness(parts)).toBe('as of 2026-10-14 to 2026-10-15 (1 undated)');
  });
});
