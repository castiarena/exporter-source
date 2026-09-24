import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The lint rules that matter here are the security ones: the posture in
 * 01-requirements.md §4 depends on `eval`, `new Function`, `fetch` and friends
 * never appearing in first-party code, so those are errors, not warnings.
 * scripts/verify-no-remote.mjs enforces the same thing against the built output.
 */
export default tseslint.config(
  {
    ignores: ['dist/', 'dist-test/', 'vendor/', 'artifacts/', 'node_modules/', 'test-results/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'This extension makes no network requests.' },
        { name: 'XMLHttpRequest', message: 'This extension makes no network requests.' },
        { name: 'WebSocket', message: 'This extension makes no network requests.' },
        { name: 'EventSource', message: 'This extension makes no network requests.' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
    },
  },
  {
    // Build tooling and tests run in Node and are allowed to talk to the world.
    files: ['scripts/**/*.mjs', '*.config.{ts,mjs}', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },
);
