/** `?scene3d=1` — the 3D scene layer is opt-in until its owner has reviewed it. See mount.ts. */
export const SCENE3D_REQUESTED: boolean =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scene3d') === '1'
