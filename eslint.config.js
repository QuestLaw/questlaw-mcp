/**
 * Lint config for this package only.
 *
 * The rules are the QuestLaw extension's own baseRules, so this package meets the
 * same standard, and only the language options differ (Node CommonJS throughout).
 *
 * eslint is the package's one devDependency. It never ships: package.json `files`
 * leaves it out, and the server has no runtime dependencies at all. The Node
 * globals are listed here rather than taken from the `globals` package, so linting
 * adds one package to a contributor's install instead of two.
 */
'use strict';

const NODE_GLOBALS = Object.fromEntries([
  'AbortController', 'Buffer', 'URL', 'URLSearchParams', 'TextDecoder', 'TextEncoder',
  '__dirname', '__filename', 'clearImmediate', 'clearInterval', 'clearTimeout', 'console',
  'exports', 'global', 'globalThis', 'module', 'process', 'queueMicrotask', 'require',
  'setImmediate', 'setInterval', 'setTimeout', 'structuredClone'
].map(name => [name, 'readonly']));

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      curly: ['error', 'multi-line'],
      'default-case': 'error',
      'no-fallthrough': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-return-await': 'error',
      complexity: ['error', 15],
      'max-depth': ['error', 4]
    }
  }
];
