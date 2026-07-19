/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TARGET?: 'mobile' | 'windows'
  readonly VITE_GIT_HASH?: string
  readonly VITE_MOBILE_APP_URL?: string
  readonly VITE_WINDOWS_APP_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
