// The site's languages, shared by the server (which picks the first language to render) and the browser.
export const LANGUAGES = [
  { code: "en", label: "English", short: "EN" },
  { code: "hi", label: "हिन्दी", short: "हि" },
  { code: "gu", label: "ગુજરાતી", short: "ગુ" },
] as const

export type Language = (typeof LANGUAGES)[number]["code"]

export const LANGUAGE_KEY = "metro_language"

export const isLanguage = (code: unknown): code is Language => LANGUAGES.some((l) => l.code === code)

/** The saved choice, else a Hindi or Gujarati browser gets that language (as navigator.language did). */
export function pickLanguage(saved: string | undefined, acceptLanguage: string | null): Language {
  if (isLanguage(saved)) return saved
  const browser = (acceptLanguage ?? "").split(",")[0]!.trim().toLowerCase()
  return browser.startsWith("gu") ? "gu" : browser.startsWith("hi") ? "hi" : "en"
}
