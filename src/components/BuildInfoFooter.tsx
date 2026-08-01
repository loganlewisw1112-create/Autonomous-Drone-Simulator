export const BUILD_INFO = Object.freeze({
  version: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
  target: import.meta.env.VITE_BUILD_TARGET ?? 'windows',
  gitSha: import.meta.env.VITE_GIT_HASH ?? 'unknown',
  distributionChannel: import.meta.env.VITE_DISTRIBUTION_CHANNEL ?? 'development',
  licenseExpiresAt: import.meta.env.VITE_LICENSE_EXPIRES_AT ?? null,
})

/** Read-only visible provenance carried by every target shell. */
export function BuildInfoFooter() {
  return (
    <div
      data-testid="build-info"
      aria-label="Build information"
      style={{
        position: 'fixed',
        right: 6,
        bottom: 4,
        zIndex: 10_000,
        maxWidth: 'min(96vw, 720px)',
        padding: '3px 6px',
        border: '1px solid rgba(138, 148, 166, 0.35)',
        borderRadius: 4,
        background: 'rgba(7, 10, 15, 0.9)',
        color: 'var(--text-dim, #8a94a6)',
        font: '9px/1.25 var(--font-mono, monospace)',
        overflowWrap: 'anywhere',
        pointerEvents: 'none',
      }}
    >
      v{BUILD_INFO.version} · {BUILD_INFO.target} · {BUILD_INFO.distributionChannel.replaceAll('_', ' ')} · commit: {BUILD_INFO.gitSha}{BUILD_INFO.licenseExpiresAt ? ` · expires ${BUILD_INFO.licenseExpiresAt}` : ''} · agency training simulator only
    </div>
  )
}
