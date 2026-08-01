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
      },
    },
  },
})
