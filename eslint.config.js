import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'model/'] },
  js.configs.recommended,
  // Type-aware rules: floating promises, always-true conditions, unsafe `any` flows...
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      // Numbers in template strings are harmless and common in this code base.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // A Node import hook, plain JavaScript and outside the TypeScript project.
    files: ['eslint.config.js', 'tools/ts-imports.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
