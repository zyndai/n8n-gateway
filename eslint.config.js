import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/db/migrations', 'packages/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (scripts/*.mjs) run on Node 20+, which has these as globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(['console', 'fetch', 'setTimeout', 'setInterval', 'clearInterval'].map((g) => [g, 'readonly'])),
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
