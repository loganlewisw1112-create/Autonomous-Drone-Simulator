/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TARGET?: 'mobile' | 'windows' | 'classroom'
  readonly VITE_GIT_HASH?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_BUILD_TARGET?: 'windows' | 'mobile' | 'classroom'
  readonly VITE_MOBILE_APP_URL?: string
  readonly VITE_WINDOWS_APP_URL?: string
  readonly VITE_CLASSROOM_ENABLED?: string
  readonly VITE_CLASSROOM_WS_URL?: string
  readonly VITE_DISTRIBUTION_CHANNEL?: 'development' | 'public_demo' | 'licensed_windows' | 'windows_evaluation' | 'classroom_pilot' | 'agency_training_pilot'
  readonly VITE_LICENSE_EXPIRES_AT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
