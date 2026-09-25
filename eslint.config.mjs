import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Not type-aware on purpose: `tsc --noEmit` covers types; this is for what types cannot see.
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  { files: ['**/*.test.ts', 'scripts/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
