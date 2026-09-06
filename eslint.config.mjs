import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'dist/**',
    'coverage/**',
    'node_modules/**',
    'test-results/**',
    'vendor/**',
    // Scratch files the remember plugin writes; ignored by its own nested
    // .gitignore, which flat config does not read.
    '.remember/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Playwright driver scripts run in Node, but the callbacks they hand to
    // page.evaluate are serialized and executed in the browser, so both sets of
    // globals are legitimately in scope in one file.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      // Tests intentionally exercise constant conditional class inputs.
      'no-constant-binary-expression': 'off',
    },
  },
  {
    files: ['src/svartaksi/svartaksiRuntime.tsx'],
    rules: {
      // react-three-fiber's whole integration model is mutating hook-returned
      // THREE.js objects (scene/gl/camera from useThree/useFrame) and this file's
      // own shared "control" bridge object (see its doc comment) imperatively
      // inside effects/useFrame — the standard, necessary R3F pattern, not the
      // accidental prop/hook-value mutation this React-Compiler-oriented rule is
      // meant to catch in an otherwise-pure component. Scoped to this file, the
      // project's one deep R3F integration point, rather than disabled globally.
      'react-hooks/immutability': 'off',
      // This file's primary export is createSvartaksiRuntime, an imperative factory —
      // it is not a component consumed/fast-refreshed like a normal page/feature
      // component, so the single-export-type constraint doesn't apply here.
      'react-refresh/only-export-components': 'off',
    },
  },
);
