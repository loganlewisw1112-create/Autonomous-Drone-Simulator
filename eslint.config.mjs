import pluginTs from '@typescript-eslint/eslint-plugin'
import parserTs from '@typescript-eslint/parser'

export default [
  { ignores: ['dist/', 'node_modules/', 'vite.config.js'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: parserTs,
      parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': pluginTs },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
]
