export type AppTarget = 'universal' | 'mobile' | 'windows'

export const MOBILE_APP_URL = import.meta.env.VITE_MOBILE_APP_URL
  ?? 'https://autonomous-drone-simulator-mobile.vercel.app/'

export const WINDOWS_APP_URL = import.meta.env.VITE_WINDOWS_APP_URL
  ?? 'https://autonomous-drone-simulator.vercel.app/'

export function resolveAppTarget(value: unknown): AppTarget {
  return value === 'mobile' || value === 'windows' ? value : 'universal'
}

export const APP_TARGET = resolveAppTarget(import.meta.env.VITE_APP_TARGET)

export function isWindowsPlatform(platform = '', userAgent = ''): boolean {
  return /windows|win32|win64/i.test(`${platform} ${userAgent}`)
}

export function isWindowsClient(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return isWindowsPlatform(nav.userAgentData?.platform ?? nav.platform, nav.userAgent)
}
