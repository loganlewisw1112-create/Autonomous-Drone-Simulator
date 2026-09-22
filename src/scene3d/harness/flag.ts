/**
 * Harness gate. TWO locks, both required:
 *  1. compile-time — `VITE_HARNESS=1` at build (only `harness/server.mjs` sets it). Public
 *     builds define it as '' so this folds to `false` and the harness chunk is never emitted.
 *  2. run-time — `?harness=1` in the URL.
 *
 * The flag only suppresses self-dismissing onboarding chrome (loading screen, welcome overlay)
 * and installs `window.__harness`. It deliberately does NOT bypass the usage-policy gate, the
 * Windows platform gate, licensing, or sign-in — those are product controls, not interstitials.
 */
export const HARNESS_ENABLED: boolean =
  import.meta.env.VITE_HARNESS === '1' &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('harness') === '1'
