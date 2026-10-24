// Cookie / localStorage keys shared by the server (which renders the saved theme) and the browser.
// Not in theme.tsx: a "use client" module's plain exports are only references on the server.
export type Theme = "light" | "dark"

export const THEME_KEY = "metro_theme"
