import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import lit from 'eslint-plugin-lit'
import wc from 'eslint-plugin-wc'
import globals from 'globals'

// Flat config (ESLint 10). Type-aware via the TS project service, which reads
// tsconfig.app.json (src) and tsconfig.node.json (electron/plugins) directly.
export default tseslint.config(
  { ignores: ['dist/', 'dist-electron/', 'release/'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // tsc already enforces this via noUnusedLocals/noUnusedParameters.
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },

  // Renderer: Lit web components in the browser.
  {
    files: ['src/**/*.ts'],
    extends: [lit.configs['flat/recommended'], wc.configs['flat/recommended']],
    languageOptions: { globals: globals.browser },
    // Lit calls template handlers with `this` bound to the host, so method
    // references in `@event`/`.prop` bindings are safe despite this rule.
    rules: { '@typescript-eslint/unbound-method': 'off' },
  },

  // Main process, preload, plugins, and the Vite config run under Node.
  {
    files: ['electron/**/*.ts', 'plugins/**/*.ts', 'vite.config.ts'],
    languageOptions: { globals: globals.node },
  },

  // Sync drivers (sqlite) implement the async Driver interface, so their
  // methods are legitimately async without an await.
  {
    files: ['electron/db/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // Tests lean on method references and stub casts that the type-aware rules
  // flag but are fine in a test harness.
  {
    files: ['**/*.test.ts', 'src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  // This config file isn't part of a tsconfig, so type-aware rules can't apply.
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
)
