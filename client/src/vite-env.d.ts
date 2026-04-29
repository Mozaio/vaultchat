/// <reference types="vite/client" />

declare module "libsodium-wrappers-sumo" {
  const sodium: unknown;
  export default sodium;
}

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_VAULTCHAT_ENABLE_X3DH?: string;
  readonly VITE_VAULTCHAT_ALLOW_LEGACY_DH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
