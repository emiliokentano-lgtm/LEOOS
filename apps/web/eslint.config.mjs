import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

/**
 * Lint rules that hold engineering rules the compiler cannot.
 * Notably `react/no-danger` — engineering rule 14 bans raw HTML injection,
 * and a review-time catch is not an enforcement mechanism.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      'react/no-danger': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
];

export default config;
