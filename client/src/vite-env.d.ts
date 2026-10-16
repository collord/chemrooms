/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN: string;
  readonly VITE_DATA_URL: string;
  /** Set to open an EQuIS ARII export instead of ChemDuck parquet. */
  readonly VITE_ARII_MANIFEST_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
