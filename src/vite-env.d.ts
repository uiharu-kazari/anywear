/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'anna' for the Anna AI OS edition; unset for the web app. */
  readonly VITE_TARGET?: 'anna';
  /** Absolute API origin when the bundle is not served by our own server. */
  readonly VITE_API_BASE?: string;
}
