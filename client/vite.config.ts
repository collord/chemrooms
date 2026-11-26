import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {defineConfig, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cesium from 'vite-plugin-cesium';

/**
 * The @duckdb/duckdb-wasm version SQLRooms' WASM connector imports, which
 * is the engine it fetches from jsDelivr (getJsDelivrBundles). It is resolved
 * from @sqlrooms/duckdb, not from this package, because the two can differ:
 * Mosaic brings its own copy (1.30.0 beside 1.32.0 today).
 */
function duckdbWasmVersion(): string {
  const fromHere = createRequire(import.meta.url);
  const fromSqlrooms = createRequire(fromHere.resolve('@sqlrooms/duckdb'));
  let dir = path.dirname(fromSqlrooms.resolve('@duckdb/duckdb-wasm'));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    try {
      const json = JSON.parse(readFileSync(pkg, 'utf8'));
      if (json.name === '@duckdb/duckdb-wasm') return json.version;
    } catch {
      // not here; go up
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('@duckdb/duckdb-wasm package.json not found');
    dir = up;
  }
}

/** Fill index.html's preload URLs with that version. */
function duckdbWasmPreloadVersion(): Plugin {
  const version = duckdbWasmVersion();
  return {
    name: 'duckdb-wasm-preload-version',
    transformIndexHtml: (html) => html.replaceAll('__DUCKDB_WASM_VERSION__', version),
  };
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/chemrooms/' : '/',
  plugins: [
    react(),
    tailwindcss(),
    cesium({rebuildCesium: true}),
    duckdbWasmPreloadVersion(),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify(
      process.env.GITHUB_ACTIONS ? '/chemrooms/cesium' : '/cesium',
    ),
  },
  build: {
    chunkSizeWarningLimit: 6000,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: 'all',
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  optimizeDeps: {
    include: ['cesium'],
  },
});
