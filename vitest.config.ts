import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const coverageFastKdf = process.env.VITEST_COVERAGE_FAST_KDF === '1'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    // Default environment stays 'node' so the 178 existing simulation/state tests remain fast.
    // Component specs opt into jsdom per-file via a `// @vitest-environment jsdom` docblock.
    environment: 'node',
    globals: true,
    setupFiles: [
      './src/tests/setup.ts',
      ...(coverageFastKdf ? ['./src/tests/coverageFastKdf.ts'] : []),
    ],
    exclude: [
      ...configDefaults.exclude,
      ...(coverageFastKdf ? ['src/tests/cryptoPolicy.spec.ts'] : []),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: [
        'src/tests/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/scenarios/fixtures/**',
      ],
      thresholds: {
        statements: 50,
        lines: 50,
        functions: 40,
        branches: 40,
        // Audit F-09: these high-risk modules previously sat at 0% direct coverage while the
        // aggregate gate stayed green, so a total loss of their tests (deleted/renamed spec,
        // broken import) would go unnoticed. Floors are set deliberately BELOW what the
        // dedicated specs achieve (preflightHappyPath / signInAccountPanels / missionExports
        // measured ~60-100% per metric) — they exist to catch coverage collapsing back to
        // zero, not to enforce a high-water mark.
        'src/components/PreflightChecklist.tsx': { lines: 45, statements: 45, functions: 40, branches: 35 },
        'src/components/account/SignInModal.tsx': { lines: 60, statements: 60, functions: 50, branches: 60 },
        'src/components/account/AccountPanels.tsx': { lines: 25, statements: 25, functions: 20, branches: 25 },
        'src/utils/kmlExport.ts': { lines: 70, statements: 70, functions: 70, branches: 70 },
        'src/utils/geojsonExport.ts': { lines: 70, statements: 70, functions: 70, branches: 60 },
      },
    },
  },
})
