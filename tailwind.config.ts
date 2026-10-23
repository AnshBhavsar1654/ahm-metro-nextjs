/**
 * Tailwind config carried over from the CRA frontend with contents untouched.
 * The design tokens are CSS variables (RGB channels) defined in src/app/globals.css,
 * so one class works in light and dark mode.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`

const config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: token("ink-900"), 600: token("ink-600"), 300: token("ink-300") },
        line: { 200: token("line-200"), 100: token("line-100") },
        surface: { 0: token("surface-0"), 1: token("surface-1") },
        // navy = filled chrome (navbar, headers, primary buttons). accent = navy-as-ink: links, icons, outlines.
        navy: { 900: token("navy-900"), 700: token("navy-700"), 100: token("navy-100") },
        // chrome = the navbar only.
        chrome: { 900: token("chrome-900"), 700: token("chrome-700") },
        accent: token("accent"),
        alert: { 600: token("alert-600") },
        go: { 600: token("go-600") },
      },
      fontFamily: {
        // Plex for Latin and Devanagari (Hindi); Noto Sans Gujarati for Gujarati, which Plex doesn't cover.
        sans: ['"IBM Plex Sans"', '"IBM Plex Sans Devanagari"', '"Noto Sans Gujarati"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', '"IBM Plex Sans Devanagari"', '"Noto Sans Gujarati"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
}

export default config
