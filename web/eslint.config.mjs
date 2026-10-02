import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * eslint-config-next 15 still ships a legacy eslintrc shaped config, so FlatCompat
 * translates it into the flat config format that eslint 9 wants.
 */
const compat = new FlatCompat({ baseDirectory: here });

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // The de-identification layer and the chain client both decode values whose shape is
      // only known at runtime. `unknown` is the right type there, and narrowing is explicit,
      // so a stray `any` should be a hard error rather than a warning.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
