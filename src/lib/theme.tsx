"use client"

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react"
import { THEME_KEY, type Theme } from "./preferences"

export type { Theme }

const query = () =>
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null
// useLayoutEffect warns during server rendering; this runs it only in the browser.
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

const readStored = (): Theme | null => {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === "dark" || value === "light" ? value : null
  } catch {
    return null
  }
}

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({ theme: "light", toggleTheme: () => {} })

/**
 * The class is first set by an inline script in the layout (no flash); this keeps it in sync afterwards.
 * `initialTheme` is the rider's saved choice, from the cookie the server reads, so the server renders the
 * same theme; without one the page follows the operating system once it runs in the browser.
 */
export const ThemeProvider = ({ initialTheme, children }: { initialTheme: Theme | null; children: React.ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(initialTheme ?? "light")

  useBrowserLayoutEffect(() => {
    const stored = readStored()
    setTheme(stored || (query()?.matches ? "dark" : "light"))
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0A0C11" : "#FAFBF8")
  }, [theme])

  // Until the rider picks a theme themselves, follow the operating system.
  useEffect(() => {
    const media = query()
    if (!media) return undefined
    const onChange = (e: MediaQueryListEvent) => {
      if (!readStored()) setTheme(e.matches ? "dark" : "light")
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark"
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        /* storage unavailable: choice just won't persist */
      }
      document.cookie = `${THEME_KEY}=${next}; path=/; max-age=31536000; samesite=lax`
      return next
    })
  }, [])

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)

export type MapPalette = { ink: string; route: string; fill: string; neutral: string }

// Colours for things drawn outside Tailwind (Leaflet markers and polylines). Stable objects, safe in hook deps.
const PALETTES: Record<Theme, MapPalette> = {
  light: { ink: "#12151B", route: "#0E2340", fill: "#FFFFFF", neutral: "#4B5160" },
  dark: { ink: "#E8EAEE", route: "#8DB4F0", fill: "#171C25", neutral: "#A0A7B4" },
}

export const mapPalette = (theme: string): MapPalette => PALETTES[theme as Theme] || PALETTES.light
