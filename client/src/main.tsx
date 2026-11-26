import React from 'react';
import ReactDOM from 'react-dom/client';
import {ariiToProbe, probeSidecars} from './sidecarProbe';

import 'cesium/Build/Cesium/Widgets/widgets.css';
import './index.css';

import {Ion} from 'cesium';
Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN ?? '';

/**
 * Find an ARII source's sidecar folder BEFORE importing the app. The room
 * store is created at module load from config.ts, which reads the probe's
 * answer (sidecarProbe.ts), so App is imported only once it is known.
 */
async function start() {
  const arii = ariiToProbe(window.location.hash, import.meta.env);
  if (arii) await probeSidecars(arii.manifestUrl, arii.namedFolder);
  const {App} = await import('./App');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
