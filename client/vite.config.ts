import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/chemrooms/' : '/',
  plugins: [react(), tailwindcss(), cesium({rebuildCesium: true})],
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
