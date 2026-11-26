import {describe, it, expect} from 'vitest';
import {defaultSidecarFolder, joinUrl, resolveSource, sourceHash, sourceParams} from './config';

const SAS = '?sv=2024-11-04&sr=c&sig=a%2Fb%3D';
const MANIFEST = 'https://acct.blob.core.windows.net/exports/site-a/manifest.json';

describe('joinUrl', () => {
  it('puts the path before a signed URL query string', () => {
    expect(joinUrl(`https://h/c/site-a/chemrooms${SAS}`, 'sql/03_views.sql')).toBe(
      `https://h/c/site-a/chemrooms/sql/03_views.sql${SAS}`,
    );
  });
  it('does not double slashes', () => {
    expect(joinUrl('https://h/data/', '/locations.parquet')).toBe('https://h/data/locations.parquet');
    expect(joinUrl('./data', 'sidecars.json')).toBe('./data/sidecars.json');
  });
});

describe('defaultSidecarFolder', () => {
  it("is the pipeline's chemduck folder beside the manifest, with its token", () => {
    expect(defaultSidecarFolder(MANIFEST + SAS)).toBe(
      `https://acct.blob.core.windows.net/exports/site-a/chemduck${SAS}`,
    );
  });
  it('names another folder beside it', () => {
    expect(defaultSidecarFolder(MANIFEST + SAS, 'chemrooms')).toBe(
      `https://acct.blob.core.windows.net/exports/site-a/chemrooms${SAS}`,
    );
  });
});

describe('resolveSource', () => {
  const env = {VITE_DATA_URL: 'https://build/data', VITE_ARII_MANIFEST_URL: undefined};

  it('opens an ARII manifest from the fragment, sidecars beside it', () => {
    const s = resolveSource('#' + sourceHash({manifest: MANIFEST + SAS}), {}, false);
    expect(s).toEqual({
      kind: 'arii',
      manifestUrl: MANIFEST + SAS,
      dataBaseUrl: `https://acct.blob.core.windows.net/exports/site-a/chemduck${SAS}`,
      from: 'link',
    });
  });

  it('uses the sidecar folder main.tsx found, unless the source names one', () => {
    const found = `https://acct.blob.core.windows.net/exports/site-a/chemrooms${SAS}`;
    const hash = '#' + sourceHash({manifest: MANIFEST + SAS});
    expect(resolveSource(hash, {}, false, found)?.dataBaseUrl).toBe(found);
    const named = '#' + sourceHash({manifest: MANIFEST, data: 'https://elsewhere/side'});
    expect(resolveSource(named, {}, false, found)?.dataBaseUrl).toBe('https://elsewhere/side');
    expect(
      resolveSource('', {VITE_ARII_MANIFEST_URL: MANIFEST}, false, found)?.dataBaseUrl,
    ).toBe(found);
  });

  it('takes an explicit sidecar folder', () => {
    const s = resolveSource('#' + sourceHash({manifest: MANIFEST, data: 'https://elsewhere/side'}), {}, false);
    expect(s?.dataBaseUrl).toBe('https://elsewhere/side');
  });

  it('opens a ChemDuck folder when only data is given', () => {
    expect(resolveSource('#data=https%3A%2F%2Fh%2Fdata', {}, false)).toMatchObject({
      kind: 'chemduck',
      dataBaseUrl: 'https://h/data',
    });
  });

  it('prefers the link over the build, and the build over the dev default', () => {
    expect(resolveSource('#data=https%3A%2F%2Flink', env, true)?.dataBaseUrl).toBe('https://link');
    expect(resolveSource('', env, true)?.from).toBe('build');
    expect(resolveSource('', {}, true)?.from).toBe('dev-default');
  });

  it('opens nothing in a production build with no link and no env', () => {
    expect(resolveSource('', {}, false)).toBeNull();
  });

  it('ignores bookmark parameters', () => {
    expect(resolveSource('#lat=1&lon=2&analytes=Lead', {}, false)).toBeNull();
    expect(sourceParams('#manifest=x&lat=1')).toEqual({manifest: 'x', data: null});
  });

  it('round-trips a signed URL through the fragment', () => {
    const hash = sourceHash({manifest: MANIFEST + SAS});
    expect(sourceParams(hash).manifest).toBe(MANIFEST + SAS);
  });
});
