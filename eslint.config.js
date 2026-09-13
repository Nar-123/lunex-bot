// ESLint 9 flat config — the smallest config that matches this project's
// EXISTING conventions (audited before writing, per the Phase 5 brief):
//
//  1. TypeScript-strict correctness rules only. The project already runs
//     `tsc --noEmit` with `strict: true` + `noUncheckedIndexedAccess` in
//     its gates, so this config layers typescript-eslint's
//     recommended-type-checked + strict-type-checked presets on top — it
//     must find what the compiler cannot (misused `await`, floating
//     promises, unsafe `any` handling around external API responses),
//     not re-enforce what the compiler already does.
//  2. NO formatting/stylistic rules. The codebase has a consistent
//     hand-written style (long doc comments, deliberate line-length
//     discipline) enforced by review, not by a formatter; adding
//     formatting rules now would generate noise, not signal. This is why
//     `stylistic-type-checked` is NOT included.
//
// Intentional exceptions (documented, deliberate — never rule-weakening
// to make lint pass):
//  - `@typescript-eslint/no-unused-vars` args: 'none'. Test doubles in
//    this codebase deliberately inject and IGNORE dependencies (e.g. a
//    fake `readTokenBalance` passed to satisfy a deps object whose other
//    members the test doesn't exercise); prefixing every intentionally-
//    unused parameter with `_` would churn hundreds of test lines for
//    zero safety. Unused LOCALS and imports still fail. An explicit
//     `^_` opt-out remains available for locals.
//  - The `ui/` tree has its own tsconfig/build and is deliberately not
//    linted by this config (same scope as `npm run lint`'s existing
//    `src/**/*.ts` glob).
//
// Uses the plugin's own `flat/*` presets (arrays of flat-config objects)
// rather than the legacy `extends`-shaped configs, which do not compose
// into a flat config. The `languageOptions` block MUST come with
// `parserOptions.project` so the type-checked rules can resolve types
// from tsconfig.json.

const tsParser = require('@typescript-eslint/parser');
const tseslint = require('@typescript-eslint/eslint-plugin');

const forSrc = (entry) => ({ ...entry, files: ['src/**/*.ts'] });
// ops/lunex-ai (the development supervisor) gets the SAME rule set, typed
// against its own tsconfig -- it is a separate program, not part of the
// trading runtime, so `npm run lint` (src/ only) is unaffected.
const AI_FILES = ['ops/lunex-ai/src/**/*.ts'];
const forAi = (entry) => ({ ...entry, files: AI_FILES });

module.exports = [
  // Type information for every linted file, from the project's real
  // tsconfig (the same one `npm run typecheck` uses).
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },
  {
    files: AI_FILES,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./ops/lunex-ai/tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },
  ...tseslint.configs['flat/recommended-type-checked'].map(forSrc),
  ...tseslint.configs['flat/strict-type-checked'].map(forSrc),
  ...tseslint.configs['flat/recommended-type-checked'].map(forAi),
  ...tseslint.configs['flat/strict-type-checked'].map(forAi),
  {
    files: ['src/**/*.ts', ...AI_FILES],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none', // see header: test doubles inject-and-ignore by design
          varsIgnorePattern: '^_', // an explicit opt-out remains available
        },
      ],
      // CONVENTION (documented): the codebase's pervasive, deliberate
      // `${number}` / `${bigint}` string building (raw-unit logging, error
      // messages) is what the rule's own DEFAULT (recommended) stance
      // permits; only strict-type-checked tightens allowNumber/allowNullish
      // to false. Reverting exactly those two options to the recommended
      // default preserves the rule's real value (banning object/function
      // interpolation) without re-writing 88 correct sites.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowNullish: true },
      ],
    },
  },
];
