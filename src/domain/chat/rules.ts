/**
 * Instant chatbot answers with no model call: understanding the rider's message and replying from
 * the app's data — the 1:1 TypeScript port of backend/chatbot/rules.py.
 *
 * Works for English, Gujarati and Hindi, including Gujarati/Hindi typed in Latin letters. A few
 * milliseconds. Sections: station names in local scripts (./rules-data.json), message understanding
 * (language, stations, intent), reply templates.
 */
import { getAllStations, journeyNotOpen, type Route } from "@/domain/metro/network"
import { journeyMinutes, throughService } from "@/domain/metro/timetable"
import { getCloseMatches, pyFixed, pyRegex } from "./pycompat"
import data from "./rules-data.json"

export type Lang = "en" | "gu" | "hi"
type Replies = Record<Lang, string>

// canonical -> [Gujarati, Hindi]; extra Latin spellings (lowercase); lines in the rider's language.
export const NAMES_LOCAL: Record<string, string[]> = data.names_local
const EXTRA_LATIN: Record<string, string[]> = data.extra_latin
const LINE_LOCAL: Record<string, string[]> = data.line_local

// ==================================================================================================
// Understanding: language, stations mentioned, simple intents
// ==================================================================================================

// ---------------------------------------------------------------- text normalisation

// Fold long/short vowel variants so "ઇન્ફોસિટી" and "ઈન્ફોસિટી" compare equal.
const FOLD: Record<string, string> = {
  "ી": "િ",
  "ૂ": "ુ",
  ઈ: "ઇ",
  ઊ: "ઉ", // Gujarati
  "ी": "ि",
  "ू": "ु",
  ई: "इ",
  ऊ: "उ",
  "ँ": "ं", // Devanagari
  "़": "",
  "​": "",
  "‌": "",
  "‍": "",
}
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join("")}]`, "gu")
const PUNCT = /[\s\-_.,;:!?()[\]{}"'/\\|]+/gu

export function normalise(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(FOLD_RE, (ch) => FOLD[ch]!)
    .replace(PUNCT, " ")
    .trim()
}

const isLocal = (ch: string): boolean => ch >= "ऀ" && ch <= "෿"
const hasLocal = (text: string): boolean => Array.from(text).some(isLocal)

// ---------------------------------------------------------------- language

const GU_STRONG = new Set([
  "bhadu",
  "bhaadu",
  "bhado",
  "bhada",
  "ketlu",
  "ketla",
  "ketlo",
  "thay",
  "thai",
  "javanu",
  "chhe",
  "kyan",
  "kyathi",
  "mane",
  "mare",
  "joiye",
  "shu",
  "sudhi",
  "kevi",
  "thi",
  "kem",
  "cho",
  "chho",
  "tamne",
  "amare",
  "aapo",
  "batavo",
])
const HI_STRONG = new Set([
  "kiraya",
  "kitna",
  "kitne",
  "kitni",
  "kaise",
  "kahan",
  "kahaan",
  "mujhe",
  "hai",
  "hain",
  "jana",
  "jaana",
  "tak",
  "kya",
  "chahiye",
  "batao",
  "bataiye",
  "hoga",
  "karna",
  "kaun",
  "kidhar",
  "namaste",
])

/** "gu", "hi" or "en". */
export function detectLanguage(text: string): Lang {
  let gu = 0
  let hi = 0
  for (const c of text) {
    if (c >= "઀" && c <= "૿") gu++
    else if (c >= "ऀ" && c <= "ॿ") hi++
  }
  if (gu || hi) return gu >= hi ? "gu" : "hi"
  const words = new Set(normalise(text).split(/\s+/u).filter(Boolean))
  const guScore = [...words].filter((w) => GU_STRONG.has(w)).length
  const hiScore = [...words].filter((w) => HI_STRONG.has(w)).length
  if (guScore === 0 && hiScore === 0) return "en"
  return hiScore > guScore ? "hi" : "gu"
}

// ---------------------------------------------------------------- stations

// Words that must never be fuzzy-matched to a station.
const NOT_STATIONS = new Set([
  "metro",
  "station",
  "stations",
  "fare",
  "ticket",
  "route",
  "price",
  "from",
  "going",
  "where",
  "please",
  "which",
  "line",
  "ahmedabad",
  "gandhinagar",
  "bhadu",
  "javanu",
  "ketlu",
  "thay",
  "stop",
  "stops",
  "travel",
  "reach",
  "cost",
  "time",
  "timing",
  "timings",
  "card",
  "nearest",
  "nearby",
  "lines",
  "railway",
  "road",
  "circle",
  "park",
  "gam",
  "college",
])

const latinIndex = new Map<string, string>()
const localIndex: [alias: string, name: string][] = [] // longest first

for (const name of getAllStations()) {
  const aliases = new Set([normalise(name), ...(EXTRA_LATIN[name] ?? []).map(normalise)])
  for (const alias of [...aliases]) {
    if (alias.includes(" ")) aliases.add(alias.replaceAll(" ", ""))
  }
  for (const alias of aliases) {
    if (!latinIndex.has(alias)) latinIndex.set(alias, name)
  }
  for (const local of NAMES_LOCAL[name] ?? []) localIndex.push([normalise(local), name])
}
localIndex.sort((a, b) => b[0].length - a[0].length) // stable, like Python's sort
const latinKeys = [...latinIndex.keys()]

/** Python's str.find over code points would differ from UTF-16 indexes only for astral characters: none here. */
const isDigit = (ch: string | undefined): boolean => ch !== undefined && /\p{Nd}/u.test(ch)

/** Canonical station names mentioned in `text`, in the order they appear (no duplicates). */
export function findStations(text: string): string[] {
  const norm = normalise(text)
  const taken: [number, number][] = []
  const found: [number, string][] = []

  const free = (start: number, end: number) => taken.every(([s, e]) => end <= s || start >= e)
  const take = (start: number, end: number, name: string) => {
    taken.push([start, end])
    found.push([start, name])
  }

  // Gujarati / Hindi script: substring match (suffixes like "થી" are glued to the name), longest alias first.
  if (hasLocal(norm)) {
    for (const [alias, name] of localIndex) {
      let start = norm.indexOf(alias)
      while (start !== -1) {
        const end = start + alias.length
        const gluedDigit = isDigit(alias[alias.length - 1]) && end < norm.length && isDigit(norm[end])
        if (free(start, end) && !gluedDigit) {
          take(start, end, name)
          break
        }
        start = norm.indexOf(alias, start + 1)
      }
    }
  }

  // Latin script: word n-grams, exact first, then fuzzy for typos.
  const tokens = [...norm.matchAll(/\S+/gu)]
    .filter((m) => !hasLocal(m[0]))
    .map((m) => [m[0], m.index, m.index + m[0].length] as const)
  for (const fuzzy of [false, true]) {
    for (const n of [4, 3, 2, 1]) {
      for (let i = 0; i < tokens.length - n + 1; i++) {
        const window = tokens.slice(i, i + n)
        const start = window[0]![1]
        const end = window[window.length - 1]![2]
        if (!free(start, end)) continue
        const phrase = window.map((t) => t[0]).join(" ")
        let name: string | undefined
        if (!fuzzy) {
          name = latinIndex.get(phrase)
        } else {
          if (phrase.length < 5 || NOT_STATIONS.has(phrase)) continue
          const close = getCloseMatches(phrase, latinKeys, 3, 0.8).filter((k) => k[0] === phrase[0])
          name = close.length ? latinIndex.get(close[0]!) : undefined
        }
        if (name) take(start, end, name)
      }
    }
  }

  const ordered: string[] = []
  found.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  for (const [, name] of found) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  // "to Y from X" reads backwards.
  if (ordered.length === 2 && pyRegex(String.raw`\bto\b.+\bfrom\b`).test(norm)) ordered.reverse()
  return ordered
}

// ---------------------------------------------------------------- intents

const FARE = pyRegex(
  String.raw`\b(fare|fares|price|cost|charge|charges|rate|how much|ticket|tickets|bhadu|bhaadu|bhado|bhada|kiraya|kiraaya)\b` +
    "|ભાડ|ટિકિટ|કિંમત|किराया|टिकट|कीमत|दाम",
)
const DURATION = pyRegex(
  String.raw`\b(how long|duration|how much time|minutes|samay|vakht|vakhat|time lage|time lagse|lagse)\b|સમય|વાર લાગ|समय|कितनी देर`,
)
// Words that clearly ask for directions or a line breakdown...
const ROUTE_STRONG = pyRegex(
  String.raw`\b(route|routes|direction|directions|which line|interchange|interchanges|change|transfer|stations? between|how many stations|distance|` +
    String.raw`how (do|to|can) (i |we )?(go|get|reach)|rasta|raasta|kaise)\b|રૂટ|રસ્તો|માર્ગ|અંતર|કઈ લાઇન|કેવી રીતે|` +
    "कैसे|मार्ग|रास्ता|दूरी|कौन सी लाइन",
)
// ...versus plain "going to" words, which accompany fare questions too ("javanu bhadu ketlu").
const ROUTE_WEAK = pyRegex(String.raw`\b(reach|travel|go|going|javanu|javu|jaay|jaye)\b|જવું|જવાનું|પહોંચ|जाना|जाएं|पहुँच|पहुंच`)
const GREETING_RE = pyRegex(
  String.raw`^(?:(?:hi+|hello+|hey+|namaste|namaskar|kem cho|kem chho|good (?:morning|afternoon|evening)|jai shree krishna)\b` +
    "|નમસ્તે|નમસ્કાર|કેમ છો|હેલો|हेलो|नमस्ते|नमस्कार)",
)
const NEARBY_RE = pyRegex(
  String.raw`\b(nearest|nearby|near me|closest|najik|najeek|nazdik|nazdeek|paas)\b|નજીક|પાસે|नज़दीक|नजदीक|पास`,
)
// Questions that mention stations but are about something else: tickets, cards, passes, facilities, timings.
const BEYOND_JOURNEY = pyRegex(
  String.raw`\b(smart ?card|card|ncmc|pass|passes|discount|concession|student|senior|token|qr|refund|luggage|parking|lift|` +
    String.raw`gate|gates|wheelchair|toilet|washroom|open|underground|first train|last train|next train|timing|timings)\b` +
    "|કાર્ડ|પાસ|ગેટ|પાર્કિંગ|कार्ड|पास|गेट|पार्किंग",
)
const STATION_WORD = pyRegex(String.raw`\b(station|stations|metro)\b|સ્ટેશન|મેટ્રો|स्टेशन|मेट्रो`)

const FILLER = new Set(["", "station", "metro", "metro station", "stn", "stop"])

/** True if the message is nothing but this station's name (plus words like "station"). */
export function onlyStation(norm: string, station: string): boolean {
  const aliases = new Set<string>()
  for (const [alias, name] of latinIndex) if (name === station) aliases.add(alias)
  for (const [alias, name] of localIndex) if (name === station) aliases.add(alias)
  let leftover = norm
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) leftover = leftover.replaceAll(alias, " ")
  return FILLER.has(leftover.split(/\s+/u).filter(Boolean).join(" "))
}

export type Intent = "greeting" | "nearby" | "fare" | "route"

/** "greeting", "nearby", "fare" or "route"; null means "let the language model handle it". */
export function detectIntent(text: string, stations: string[]): Intent | null {
  const norm = normalise(text)
  const words = norm.split(/\s+/u).filter(Boolean)

  if (!stations.length && words.length <= 4 && GREETING_RE.test(norm)) return "greeting"
  if (!stations.length && NEARBY_RE.test(norm) && STATION_WORD.test(norm)) return "nearby"
  if (!stations.length || DURATION.test(norm)) return null

  if (BEYOND_JOURNEY.test(norm)) return null // "can I use my smart card to go to gift city?" is about the card, not the route

  const wantsFare = FARE.test(norm)
  const strongRoute = ROUTE_STRONG.test(norm)
  const wantsRoute = strongRoute || ROUTE_WEAK.test(norm)
  if (stations.length >= 2) {
    if (strongRoute || (wantsRoute && !wantsFare && words.length <= 8)) return "route"
    if (wantsFare) return "fare"
    // Just two stations ("paldi thaltej", "paldi to thaltej") is a journey query.
    if (words.length <= 6) return "route"
    return null
  }
  // A lone station name ("paldi", "gift city station") is the start of a journey question.
  if (onlyStation(norm, stations[0]!)) return "route"
  // One station and a fare/route word in a short message ("fare from paldi"): the reply asks for the other end.
  // A longer question about one station ("how do I reach the airport by metro?") needs the model.
  if (words.length > 5) return null
  return strongRoute ? "route" : wantsFare ? "fare" : wantsRoute ? "route" : null
}

// ==================================================================================================
// Replies in English, Gujarati and Hindi, built from route and fare data
// ==================================================================================================

const LANG_INDEX: Partial<Record<Lang, number>> = { gu: 0, hi: 1 }

export function stationLabel(name: string, lang: Lang): string {
  const i = LANG_INDEX[lang]
  return i !== undefined && NAMES_LOCAL[name] ? NAMES_LOCAL[name][i]! : name
}

export function lineLabel(line: string, lang: Lang): string {
  const i = LANG_INDEX[lang]
  return i !== undefined && LINE_LOCAL[line] ? LINE_LOCAL[line][i]! : line
}

const km = (distance: number): string => pyFixed(distance, 1).replace(/0+$/, "").replace(/\.$/, "")

/** str.format(a=..., b=...) */
export const format = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)

// ---------------------------------------------------------------- one-line replies

export const GREETING: Replies = data.replies.GREETING
export const NEARBY: Replies = data.replies.NEARBY
export const ASK_OTHER_STATION: Replies = data.replies.ASK_OTHER_STATION
export const SAME_STATION: Replies = data.replies.SAME_STATION
export const FARE_UNAVAILABLE: Replies = data.replies.FARE_UNAVAILABLE
export const UNDER_CONSTRUCTION: Replies = data.replies.UNDER_CONSTRUCTION
export const WORK_IN_PROGRESS: Replies = data.replies.WORK_IN_PROGRESS
export const DEGRADED: Replies = data.replies.DEGRADED
export const INTERRUPTED: Replies = data.replies.INTERRUPTED

// ---------------------------------------------------------------- journey replies

function facts(result: Route, lang: Lang): string {
  const [distance, stops, mins] = [km(result.distance), result.route.length, journeyMinutes(result.legs)]
  const changes = result.interchanges.map((s) => stationLabel(s, lang)).join(", ")
  if (lang === "gu") {
    const text = `અંતર લગભગ ${distance} કિમી, ${stops} સ્ટેશન, આશરે ${mins} મિનિટ.`
    return text + (changes ? ` ${changes} પર લાઇન બદલવી પડશે.` : " લાઇન બદલવાની જરૂર નથી.")
  }
  if (lang === "hi") {
    const text = `दूरी लगभग ${distance} किमी, ${stops} स्टेशन, लगभग ${mins} मिनट।`
    return text + (changes ? ` ${changes} पर लाइन बदलनी होगी।` : " लाइन बदलने की जरूरत नहीं।")
  }
  const text = `About ${distance} km, ${stops} stations, roughly ${mins} min.`
  return text + (changes ? ` Change lines at ${changes}.` : " No line change needed.")
}

export function fareReply(src: string, dst: string, fare: number | null, result: Route, lang: Lang): string {
  const [a, b] = [stationLabel(src, lang), stationLabel(dst, lang)]
  if (fare === null) return format(FARE_UNAVAILABLE[lang], { a, b })
  const head = {
    en: `Fare from ${a} to ${b}: ₹${fare}.`,
    gu: `${a}થી ${b} સુધીનું ભાડું ₹${fare} છે.`,
    hi: `${a} से ${b} तक का किराया ₹${fare} है।`,
  }[lang]
  return `${head}\n${facts(result, lang)}`
}

export function routeReply(src: string, dst: string, fare: number | null, result: Route, lang: Lang): string {
  const [a, b] = [stationLabel(src, lang), stationLabel(dst, lang)]
  const head = {
    en: `${a} to ${b}` + (fare !== null ? `, fare ₹${fare}.` : "."),
    gu: `${a}થી ${b}` + (fare !== null ? `, ભાડું ₹${fare}.` : "."),
    hi: `${a} से ${b}` + (fare !== null ? `, किराया ₹${fare}।` : "।"),
  }[lang]

  const steps: string[] = []
  result.legs.forEach((leg, index) => {
    const i = index + 1
    const [line, start, end, stops] = [
      lineLabel(leg.line, lang),
      stationLabel(leg.from, lang),
      stationLabel(leg.to, lang),
      leg.stops,
    ]
    if (lang === "gu") steps.push(`${i}. ${line}: ${start}થી ${end} (${stops} સ્ટોપ)`)
    else if (lang === "hi") steps.push(`${i}. ${line}: ${start} से ${end} (${stops} स्टॉप)`)
    else steps.push(`${i}. ${line}: ${start} to ${end} (${stops} stop${stops !== 1 ? "s" : ""})`)
  })

  const [distance, count, mins] = [km(result.distance), result.route.length, journeyMinutes(result.legs)]
  const tail = {
    en: `About ${distance} km, ${count} stations, roughly ${mins} min.`,
    gu: `અંતર લગભગ ${distance} કિમી, ${count} સ્ટેશન, આશરે ${mins} મિનિટ.`,
    hi: `दूरी लगभग ${distance} किमी, ${count} स्टेशन, लगभग ${mins} मिनट।`,
  }[lang]
  if (Object.values(journeyNotOpen(result)).includes("work in progress")) {
    steps.push(
      {
        en: "Part of this journey isn't open yet (work in progress): trains don't stop there yet and no fare has been published.",
        gu: "આ મુસાફરીનો ભાગ હજુ ખુલ્યો નથી (કામ ચાલુ છે): ત્યાં હજુ ટ્રેનો રોકાતી નથી અને ભાડું જાહેર થયું નથી.",
        hi: "इस यात्रा का कुछ हिस्सा अभी खुला नहीं है (काम जारी है): वहाँ अभी ट्रेनें नहीं रुकतीं और किराया घोषित नहीं हुआ है।",
      }[lang],
    )
  }
  if (throughService(result.legs)) {
    steps.push(
      {
        en: "Through trains run all the way, so you can stay on board (times on /schedule).",
        gu: "સીધી ટ્રેન આખા રૂટ પર જાય છે, ટ્રેન બદલવાની જરૂર નથી (સમય /schedule પર).",
        hi: "सीधी ट्रेन पूरे रूट पर जाती है, ट्रेन बदलने की जरूरत नहीं (समय /schedule पर)।",
      }[lang],
    )
  }
  return [head, ...steps, tail].join("\n")
}
