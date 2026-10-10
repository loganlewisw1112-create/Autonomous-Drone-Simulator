export type AppTarget = 'universal' | 'mobile' | 'windows' | 'classroom'

export const MOBILE_APP_URL = import.meta.env.VITE_MOBILE_APP_URL
  ?? 'https://autonomous-drone-simulator-mobile.vercel.app/'

export const WINDOWS_APP_URL = import.meta.env.VITE_WINDOWS_APP_URL
  ?? 'https://autonomous-drone-simulator.vercel.app/'

export function resolveAppTarget(value: unknown): AppTarget {
  return value === 'mobile' || value === 'windows' || value === 'classroom' ? value : 'universal'
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

/**
 * macOS desktop. iPadOS Safari also reports "MacIntel"/"Macintosh", so a Mac UA with
 * multi-touch is treated as an iPad (not a desktop).
 */
export function isMacPlatform(platform = '', userAgent = '', maxTouchPoints = 0): boolean {
  return /mac/i.test(`${platform} ${userAgent}`) && !/iphone|ipad|ipod/i.test(userAgent) && maxTouchPoints <= 1
}

/** The desktop web build (internal target id `windows`) serves Windows and Mac computers. */
export function isDesktopClient(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform ?? nav.platform
  return isWindowsPlatform(platform, nav.userAgent)
    || isMacPlatform(platform, nav.userAgent, nav.maxTouchPoints ?? 0)
}
