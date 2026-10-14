// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs', 'postcss.config.mjs', 'scripts/*.mjs', 'public/*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // Static export with images.unoptimized: plain <img>/<picture> is intended.
      '@next/next/no-img-element': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['scripts/*.mjs', '*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' } },
  },
  // Plain browser scripts served from public/ (docs.js, ADR-0099): no build step, no types.
  {
    files: ['public/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', navigator: 'readonly', location: 'readonly',
        fetch: 'readonly', setTimeout: 'readonly', IntersectionObserver: 'readonly',
      },
    },
  },
);
