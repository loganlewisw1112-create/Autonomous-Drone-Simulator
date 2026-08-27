/**
 * MapLibre 6 requires WebGL2 (WebGL1 support was removed) and reports its absence
 * *asynchronously* from the `Map` constructor as a `GPUInitializationError`. Under
 * MapLibre 5 that failure surfaced synchronously, so a `try`/`catch` around
 * `new maplibregl.Map(...)` was enough to fall back. It no longer is: the constructor
 * returns normally, the rejection escapes the try block, and any promise waiting on a
 * `load`/`idle` event simply never settles.
 *
 * Probing before constructing keeps the documented "fall back, never throw" contract
 * deterministic on the surfaces that have a non-map fallback — locked-down machines,
 * remote-desktop sessions, older classroom hardware and headless test environments.
 */
export function hasWebGL2Support(): boolean {
  if (typeof document === 'undefined') return false

  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return false

    // Browsers cap live WebGL contexts at roughly 8-16 and this probe runs on surfaces
    // that go on to open a real one, so hand the probe context back immediately rather
    // than waiting for GC to do it.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    // A browser that throws from getContext (rather than returning null) has no usable
    // WebGL2 either, which is the only thing callers need to know.
    return false
  }
}
