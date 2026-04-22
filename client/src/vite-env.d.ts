/// <reference types="vite/client" />

declare module "libsodium-wrappers-sumo" {
  const sodium: unknown;
  export default sodium;
}

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
