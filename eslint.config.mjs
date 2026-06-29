// Scoped ESLint setup that exists ONLY to run the React Hooks / React Compiler
// rules from eslint-plugin-react-hooks v7 against the React-shipping packages.
// Biome remains the primary linter/formatter for the repo (see biome.json); this
// covers the Rules-of-React analysis Biome does not implement. Run via `pnpm lint:react`.
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['packages/react/src/**/*.{ts,tsx}', 'packages/vis/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // The full recommended set: rules-of-hooks + exhaustive-deps plus the
    // granular React Compiler diagnostics (immutability, refs, purity, globals,
    // set-state-in-render/effect, static-components, …).
    rules: reactHooks.configs['recommended-latest'].rules,
  },
];
