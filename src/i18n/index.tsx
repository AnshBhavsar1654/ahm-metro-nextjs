"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { stationStatus } from "@/lib/network"
import en from "./en"
import gu from "./gu"
import hi from "./hi"
import { LANGUAGE_KEY, isLanguage, type Language } from "./languages"
import { LINE_NAMES, STATION_NAMES } from "./names"

// The site in English, Hindi or Gujarati. The rider picks a language in the navbar; the choice is remembered in
// this browser (and in a cookie, so the server renders the page in it). On a first visit, a Hindi or Gujarati
// browser gets that language (the server reads Accept-Language).
export { LANGUAGES, type Language } from "./languages"

const DICTIONARIES: Record<Language, Record<string, string>> = { en, hi, gu }
const LOCALES: Record<Language, string> = { en: "en-IN", hi: "hi-IN", gu: "gu-IN" }

// Lookups by lowercase name, so "GIFT City" and "Gift City" both find the station.
const STATION_BY_LOWER: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(STATION_NAMES).map(([k, v]) => [k.toLowerCase(), v]),
)
const LINE_BY_NAME: Record<string, Record<string, string>> = LINE_NAMES

export type Vars = Record<string, string | number | null | undefined>

const buildValue = (lang: Language, setLang: (code: string) => void) => {
  const dict = DICTIONARIES[lang]

  // t('key', { name: 'x' }): the text in the current language, falling back to English, then to the key.
  const t = (key: string, vars?: Vars): string => {
    const text = dict[key] ?? en[key as keyof typeof en] ?? key
    return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : text
  }

  // Station and line names in the rider's script (English names pass through unchanged).
  const station = (name: string): string =>
    lang === "en" || !name ? name : (STATION_BY_LOWER[String(name).toLowerCase()]?.[lang] ?? name)
  const line = (name: string): string => (lang === "en" ? name : (LINE_BY_NAME[name]?.[lang] ?? name))

  // "Mahatma Mandir / GIFT City" -> each part in the rider's script.
  const places = (text: string): string =>
    String(text || "")
      .split(" / ")
      .map(station)
      .join(" / ")

  // Gate data from stationData.json: "Gate No. 1", "Lift No. 04 near Gate No. 01 & 02".
  const gate = (text: string): string => {
    const m = /^Gate No\. (\w+)$/.exec(text)
    return m ? t("gate.label", { n: m[1] }) : text
  }
  const facility = (text: string): string => {
    const m = /^Lift No\. (\w+) near Gate No\. (.+)$/.exec(text)
    if (!m) return text
    const gates = m[2]!.split(/\s*&\s*/).join(` ${t("gate.and")} `)
    return t("gate.lift", { lift: m[1], gates })
  }

  // A station's name with its status when it isn't open: "Airport (Work in progress)".
  const stationOption = (name: string): string => {
    const status = stationStatus(name)
    return status === "operational" ? station(name) : `${station(name)} (${t(`status.${status}`)})`
  }

  return { lang, setLang, t, station, stationOption, line, places, gate, facility, locale: LOCALES[lang] }
}

export type I18n = ReturnType<typeof buildValue>

// Without a provider (e.g. a component rendered on its own in a test) everything is English.
const I18nContext = createContext<I18n>(buildValue("en", () => {}))

export const I18nProvider = ({ initialLang, children }: { initialLang: Language; children: React.ReactNode }) => {
  const [lang, setLangState] = useState<Language>(initialLang)

  // A choice saved in this browser before the cookie existed wins once, then the cookie carries it.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LANGUAGE_KEY)
      if (isLanguage(stored) && stored !== initialLang) {
        setLangState(stored)
        document.cookie = `${LANGUAGE_KEY}=${stored}; path=/; max-age=31536000; samesite=lax`
      }
    } catch {
      /* storage unavailable */
    }
  }, [initialLang])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((code: string) => {
    if (!isLanguage(code)) return
    setLangState(code)
    try {
      localStorage.setItem(LANGUAGE_KEY, code)
    } catch {
      /* the choice just won't persist */
    }
    document.cookie = `${LANGUAGE_KEY}=${code}; path=/; max-age=31536000; samesite=lax`
  }, [])

  const value = useMemo(() => buildValue(lang, setLang), [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = () => useContext(I18nContext)
