import js from '@eslint/js'
import pluginTs from '@typescript-eslint/eslint-plugin'
import parserTs from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'outputs/',
      '.tsbuild-node/',
      'classroom-runs/',
      'local-secrets/',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      parser: parserTs,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: { '@typescript-eslint': pluginTs, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Determinism rule (REALISM_ROADMAP §3): the sim kernel and scenario data must never fetch
    // at runtime. Real data is frozen into fixtures by tools/fixtures/ at authoring time. This
    // makes the "zero network in src/sim + src/scenarios" guarantee mechanical, not a promise.
    files: ['src/sim/**/*.{ts,tsx}', 'src/scenarios/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'No runtime fetch in the sim/scenarios — freeze data into a fixture via tools/fixtures/ (REALISM_ROADMAP §3).' },
        { name: 'XMLHttpRequest', message: 'No runtime network in the sim/scenarios — use a frozen fixture (REALISM_ROADMAP §3).' },
        { name: 'WebSocket', message: 'No runtime network in the sim/scenarios — use a frozen fixture (REALISM_ROADMAP §3).' },
      ],
    },
  },
  {
    files: [
      'server/**/*.mjs',
      'desktop/**/*.{mjs,cjs}',
      'scripts/**/*.mjs',
      'tools/**/*.mjs',
    ],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]
