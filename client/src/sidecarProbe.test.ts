import {describe, it, expect} from 'vitest';
import {ariiToProbe, probeSidecars} from './sidecarProbe';

const SAS = '?sv=2024-11-04&sig=a%2Fb';
const MANIFEST = 'https://h/exports/site-a/manifest.json';

/** A host holding sidecars.json at the given folder URLs. */
function host(folders: Record<string, string[]>) {
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    const folder = Object.keys(folders).find((f) => url === `${f.split('?')[0]}/sidecars.json${f.includes('?') ? f.slice(f.indexOf('?')) : ''}`);
    if (!folder) throw new Error('404');
    return {tables: Object.fromEntries(folders[folder]!.map((t) => [t, {}]))};
  };
  return {get, asked};
}

describe('probeSidecars', () => {
  it("prefers the pipeline's chemduck/ folder", async () => {
    const h = host({
      'https://h/exports/site-a/chemduck': ['locations', 'samples', 'analyte_summary'],
      'https://h/exports/site-a/chemrooms': ['locations', 'samples', 'analyte_catalog'],
    });
    expect(await probeSidecars(MANIFEST, null, h.get)).toEqual({
      folder: 'https://h/exports/site-a/chemduck',
      tables: ['locations', 'samples', 'analyte_summary'],
    });
  });

  it('falls back to chemrooms/ for an export published by publish_arii.py', async () => {
    const h = host({'https://h/exports/site-a/chemrooms': ['locations', 'analyte_catalog']});
    const found = await probeSidecars(MANIFEST, null, h.get);
    expect(found?.folder).toBe('https://h/exports/site-a/chemrooms');
    expect(h.asked).toEqual([
      'https://h/exports/site-a/chemduck/sidecars.json',
      'https://h/exports/site-a/chemrooms/sidecars.json',
    ]);
  });

  it("keeps a signed manifest's token on each folder, after the path", async () => {
    const h = host({[`https://h/exports/site-a/chemduck${SAS}`]: ['locations']});
    const found = await probeSidecars(MANIFEST + SAS, null, h.get);
    expect(found?.folder).toBe(`https://h/exports/site-a/chemduck${SAS}`);
    expect(h.asked[0]).toBe(`https://h/exports/site-a/chemduck/sidecars.json${SAS}`);
  });

  it('asks only the named folder when one is given', async () => {
    const h = host({'https://elsewhere/side': ['locations']});
    expect((await probeSidecars(MANIFEST, 'https://elsewhere/side', h.get))?.folder).toBe(
      'https://elsewhere/side',
    );
    expect(h.asked).toEqual(['https://elsewhere/side/sidecars.json']);
  });

  it('is null when no folder answers', async () => {
    expect(await probeSidecars(MANIFEST, null, host({}).get)).toBeNull();
  });
});

describe('ariiToProbe', () => {
  it("follows config.ts's order: link manifest, link ChemDuck folder, build manifest", () => {
    const env = {VITE_ARII_MANIFEST_URL: 'https://build/manifest.json', VITE_DATA_URL: ''};
    expect(ariiToProbe('#manifest=' + encodeURIComponent(MANIFEST), env)).toEqual({
      manifestUrl: MANIFEST,
      namedFolder: null,
    });
    expect(ariiToProbe('#data=https%3A%2F%2Fh%2Fdata', env)).toBeNull();
    expect(ariiToProbe('', env)).toEqual({manifestUrl: 'https://build/manifest.json', namedFolder: null});
    expect(ariiToProbe('', {})).toBeNull();
  });
});
