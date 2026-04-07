import path from 'path';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

// In CI, sqlrooms is checked out inside the workspace (../sqlrooms relative to client/).
// Locally, it's at ../../sqlrooms (sibling to chemrooms repo).
const cesiumPkgSrc = process.env.GITHUB_ACTIONS
  ? path.resolve(__dirname, '../sqlrooms/packages/cesium/src')
  : path.resolve(__dirname, '../../sqlrooms/packages/cesium/src');

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/chemrooms/' : '/',
  plugins: [react(), cesium({rebuildCesium: true})],
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
    fs: {
      allow: ['.', cesiumPkgSrc],
    },
  },
  resolve: {
    alias: {
      '@sqlrooms/cesium': cesiumPkgSrc,
    },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  optimizeDeps: {
    include: ['cesium'],
  },
});
