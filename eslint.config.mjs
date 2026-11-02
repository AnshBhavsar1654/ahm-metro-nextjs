import nextVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

const config = [
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "next-env.d.ts"],
  },
  ...nextVitals,
  ...nextTypescript,
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
  },
  {
    // Advisory rules added with eslint-config-next 16. Kept as warnings: the flagged effects are deliberate
    // (browser-only values read after hydration, state reset when the selection changes), and
    // preserve-manual-memoization only matters with the React Compiler, which this app doesn't enable.
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"], // the files where Next's config registers react-hooks
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]

export default config
