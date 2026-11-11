import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // n8n/** holds n8n Code-node bodies (top-level return, $ globals) and a standalone preview tool.
  { ignores: ['dist', 'node_modules', 'src/db/migrations', 'packages/**', 'n8n/**'] },
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
