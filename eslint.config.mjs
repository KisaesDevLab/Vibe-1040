// @ts-check
/**
 * ESLint, at last.
 *
 * `npm run lint` has been in package.json since P0 with eslint and typescript-eslint both
 * installed, and no config was ever committed — so the command has failed outright for the whole
 * build, and CI quietly omits the step. This is that config.
 *
 * It is deliberately narrow. The repo already has a strict `tsc` (`strict`,
 * `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) doing the heavy lifting, and a lint
 * pass that duplicates the type-checker only adds noise. What is left for ESLint here is the
 * class of thing types cannot see:
 *
 *  - **The two syntaxes `--experimental-strip-types` rejects.** Parameter properties and enums
 *    compile in the built image and fail in `npm run dev`, the worker and the migration scripts.
 *    That is a CLAUDE.md rule enforced until now by reviewers remembering it.
 *  - **Floating promises**, which in this codebase mean a database write or an audit row that
 *    may not have happened before the response went out.
 *  - **`any` arriving from outside** — a model's JSON, an engine's output, a request body — and
 *    being spread through typed code unchecked.
 *
 * Rules are errors or they are absent. A warning nobody has to fix is a rule that does not exist.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `ui/` is its own package with its own tsconfig and its own React rules; linting it from
    // here would type-check it against the server's project and report nothing useful.
    // `.router/` is a checkout of the SDK, and `opentax/` is dependency-free plain JS.
    ignores: ['dist/**', 'node_modules/**', 'ui/**', '.router/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ── the two syntaxes the runtime rejects (CLAUDE.md) ──────────────────
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSParameterProperty',
          message:
            'No TypeScript parameter properties: `node --experimental-strip-types` rejects them, ' +
            'so this would work in the built image and fail in `npm run dev`, the worker and the ' +
            'migration scripts. Declare the field and assign it in the constructor body.',
        },
        {
          selector: 'TSEnumDeclaration',
          message:
            'No TypeScript enums: `node --experimental-strip-types` rejects them. Use a union of ' +
            'string literals, or a `const` object with `as const`.',
        },
      ],

      // ── promises that were never waited for ───────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // ── `any` from outside the type system ────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // ── turned off because `tsc` already says it, better ──────────────────
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // `vi.mocked(queue.add)` references a method off its object, which is what this rule is
      // for — and harmless on a `vi.fn()`, which has no `this` to lose. typescript-eslint says
      // the same about test doubles. Off here only; production code still gets the rule.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Scripts and the sidecar wrapper are plain JS run directly by node, with no project to
    // type-check against. Syntax and obvious mistakes only.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    // Node's own globals, from the `globals` package rather than a hand-written list — the
    // hand-written one missed `setTimeout`, `Buffer` and `URL`, which is how a config ends up
    // reporting the runtime's own API as undefined.
    languageOptions: { globals: globals.nodeBuiltin },
    rules: {
      // Spread rather than replaced: `rules` here would otherwise overwrite the whole of
      // `disableTypeChecked`, putting back every rule that needs a program to run against and
      // failing on this config file itself.
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
