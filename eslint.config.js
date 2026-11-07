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
    // Du JavaScript simple, hors du projet TypeScript : le crochet d'import de Node, et le
    // lanceur d'Aseprite — volontairement en JS pour tourner avec n'importe quel Node.
    files: ['eslint.config.js', 'tools/ts-imports.js', 'tools/aseprite.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
