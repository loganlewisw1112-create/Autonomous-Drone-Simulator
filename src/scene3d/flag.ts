import type { DeviceMode } from '@/hooks/useDeviceMode'

/**
 * Whether the 3D scene layer mounts. ON by default wherever the desktop presentation is showing (the
 * windows and classroom targets on a desktop-sized screen); off by default on the mobile target and on any
 * phone shell, since the mobile presentation omits desktop 3D (PROJECT_STATUS.md) and the layer's gates were
 * run on a desktop integrated GPU, not a phone. The URL overrides the default: `?scene3d=1` forces it on,
 * `?scene3d=0` forces it off. Decided once per map mount; a desktop/phone shell flip remounts the map.
 */
export type BuildTarget = 'windows' | 'mobile' | 'classroom'

export const BUILD_TARGET: BuildTarget = import.meta.env.VITE_BUILD_TARGET ?? 'windows'

export function scene3dEnabled(search: string, target: BuildTarget, deviceMode: DeviceMode): boolean {
  const requested = new URLSearchParams(search).get('scene3d')
  if (requested === '1') return true
  if (requested === '0') return false
  return target !== 'mobile' && deviceMode === 'desktop'
}
