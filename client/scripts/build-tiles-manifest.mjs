#!/usr/bin/env node
/**
 * Build a manifest.json listing all tilesets under client/public/tiles/.
 * Each subdirectory containing a tileset.json becomes an entry.
 *
 * Run before `vite build` and during dev (if tiles change).
 */

import {readdirSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILES_DIR = join(__dirname, '..', 'public', 'tiles');

mkdirSync(TILES_DIR, {recursive: true});

const tilesets = [];
for (const entry of readdirSync(TILES_DIR, {withFileTypes: true}).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (!entry.isDirectory()) continue;
  const tilesetJson = join(TILES_DIR, entry.name, 'tileset.json');
  if (existsSync(tilesetJson)) {
    tilesets.push({
      name: entry.name,
      url: `tiles/${entry.name}/tileset.json`, // relative to BASE_URL
    });
  }
}

const manifest = {tilesets};
writeFileSync(join(TILES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote tiles/manifest.json with ${tilesets.length} tileset(s)`);
