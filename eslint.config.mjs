import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

/** Legacy-style configs for the Next.js TypeScript rules, carried into flat config. */
const nextConfigs = compat.extends("next/core-web-vitals", "next/typescript");

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      "backend/**",
      "frontend/**",
    ],
  },
  ...nextConfigs,
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
  },
];

export default config;
