import { vi } from 'vitest'

// Coverage instrumentation makes the intentionally expensive production KDF
// dominate the suite and trigger unrelated component timeouts. Ordinary tests
// still exercise and assert the real 310,000-iteration policy. Coverage runs
// preserve the observable 310,000-iteration policy while the instrumented
// derive implementation caps its internal work at 1,000 iterations.
vi.mock('@/account/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/account/crypto')>()
  return {
    ...actual,
    deriveKey: (
      password: string,
      params: Parameters<typeof actual.deriveKey>[1],
    ) => actual.deriveKey(password, { ...params, iterations: Math.min(params.iterations, 1_000) }),
  }
})
