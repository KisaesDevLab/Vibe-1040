// @ts-check
/**
 * ESLint for the review UI.
 *
 * The server side got a config first; this is the same posture applied to the one part of the
 * build that had neither lint nor tests. It is narrow for the same reason — `tsc -b` already
 * runs in CI and a lint pass that repeats the type-checker is noise — so what is left is the
 * class of mistake types cannot see, and in a React app that is almost entirely **hooks**.
 *
 * That is not a theoretical worry here. The draft-return panel shipped with a dead
 * filing-status control for a week: an effect asked the server for a vocabulary using a value
 * that was wrong, a bare `catch` swallowed the miss, and the select rendered with no options
 * above a button that could never be pressed. It compiled, it type-checked, and nothing threw.
 * `react-hooks/exhaustive-deps` is the rule that catches that shape of thing, and it is an
 * error here rather than a warning, because a warning nobody has to fix is not a rule.
 */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The two that pay for themselves, as errors.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      /**
       * Off, with a reason, rather than left as noise.
       *
       * New in plugin v7's recommended set, and it is advice about cascading renders rather
       * than about correctness. Its first run found six instances and **none of them was a
       * bug**: every one is the deliberate "reset or sync local state when a prop changes"
       * pattern — a tax-year input following the bundle it belongs to, a page overlay clearing
       * its purged flag when the page changes — plus two effects whose only sin is calling an
       * async loader that sets state when it resolves.
       *
       * React would rather those were a `key` or a value derived during render. That may well
       * be the better shape, but it is six working components rewritten on a performance
       * heuristic, and a rule that requires rewriting working code to turn on is a piece of
       * work to schedule, not a lint error to leave failing.
       */
      'react-hooks/set-state-in-effect': 'off',

      // A component file that also exports something else breaks fast refresh, which is a
      // development annoyance rather than a defect — so it warns, and warnings do not fail the
      // build. It is the one rule here that is advice.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The same two syntaxes the server forbids. The UI is bundled by vite and does not run
      // under `--experimental-strip-types`, so neither would actually break here — but one
      // house rule beats two, and a component moved into a shared module would carry it along.
      'no-restricted-syntax': [
        'error',
        { selector: 'TSParameterProperty', message: 'No TypeScript parameter properties (CLAUDE.md).' },
        { selector: 'TSEnumDeclaration', message: 'No TypeScript enums: use a union of string literals (CLAUDE.md).' },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
