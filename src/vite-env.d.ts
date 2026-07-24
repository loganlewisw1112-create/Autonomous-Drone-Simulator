/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TARGET?: 'mobile' | 'windows'
  readonly VITE_GIT_HASH?: string
  readonly VITE_MOBILE_APP_URL?: string
  readonly VITE_WINDOWS_APP_URL?: string
  readonly VITE_CLASSROOM_ENABLED?: string
  readonly VITE_CLASSROOM_WS_URL?: string
  /** Injected at build time from deployment env or local-secrets (never committed). */
  readonly VITE_INSTRUCTOR_ACCESS_HASH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected by vite.config `define` when an instructor unlock digest is configured. */
declare const __INSTRUCTOR_ACCESS_HASH__: string | undefined

