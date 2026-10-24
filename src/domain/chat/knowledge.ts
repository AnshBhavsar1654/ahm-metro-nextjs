/**
 * Retrieval over the knowledge base (src/data/metro_kb.txt): the "R" in the assistant's RAG — the 1:1
 * TypeScript port of backend/chatbot/knowledge.py.
 *
 * The file is split into its "=== Heading ===" sections and indexed with BM25, plus a bonus for words in
 * a section's heading (a section is most about what its heading says). Search is lexical and in English:
 * the agent searches with English keywords whatever language the rider writes in. No embeddings, so no
 * extra API calls or quota per question.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { pySum } from "@/domain/metro/rounding"

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "can",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
  "this",
  "that",
  "there",
  "from",
  "into",
  "have",
  "has",
  "get",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "any",
  "about",
  "metro",
  "ahmedabad",
  "please",
  "tell",
  "want",
  "need",
  "obtain",
  "know",
  "some",
  "all",
])
const MIN_SCORE = 1.5 // below this a section is not really about the question

export type Section = {
  title: string
  body: string
  counts: Map<string, number> // body terms
  heading: Set<string> // title terms
}

export const sectionText = (section: Section): string => `${section.title}:\n${section.body}`

/** Crude English stemming, enough to match "passes" with "pass" and "penalties" with "penalty". */
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y"
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3)
  if (word.endsWith("sses") || word.endsWith("xes")) return word.slice(0, -2)
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1)
  return word
}

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem)
}

const countTerms = (words: string[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  return counts
}

// Read once per process. Python opened the file in text mode, so CRLF line ends become LF.
export const KB_TEXT = readFileSync(path.join(process.cwd(), "src", "data", "metro_kb.txt"), "utf8").replace(/\r\n?/g, "\n")

export const SECTIONS: Section[] = []
for (const block of KB_TEXT.split(/\n(?==== )/)) {
  const match = /^=== (.+?) ===\n+/.exec(block)
  if (match) {
    const [title, body] = [match[1]!, block.slice(match[0].length).trim()]
    SECTIONS.push({ title, body, counts: countTerms(terms(body)), heading: new Set(terms(title)) })
  }
}

const documentFrequency = new Map<string, number>()
for (const s of SECTIONS) {
  for (const t of new Set([...s.counts.keys(), ...s.heading])) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1)
}
const IDF = new Map(
  [...documentFrequency].map(([term, df]) => [term, Math.log(1 + (SECTIONS.length - df + 0.5) / (df + 0.5))] as const),
)
const length = (s: Section): number => [...s.counts.values()].reduce((a, b) => a + b, 0)
const AVG_LENGTH = SECTIONS.reduce((total, s) => total + length(s), 0) / SECTIONS.length

function score(section: Section, wanted: Set<string>): number {
  const norm = 1.2 * (0.25 + (0.75 * length(section)) / AVG_LENGTH)
  const body = pySum(
    [...wanted]
      .filter((t) => section.counts.has(t))
      .map((t) => (IDF.get(t)! * section.counts.get(t)! * 2.2) / (section.counts.get(t)! + norm)),
  )
  return body + pySum([...wanted].filter((t) => section.heading.has(t)).map((t) => 2 * IDF.get(t)!))
}

/** Up to k sections relevant to `query`, best first. Empty if nothing is relevant. */
export function search(query: string, k: number = 3): Section[] {
  const wanted = new Set(terms(query))
  if (!wanted.size) return []
  // Python: sorted(((score, index) ...), reverse=True) — ties go to the later section.
  const scored = SECTIONS.map((s, i) => [score(s, wanted), i] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1])
  return scored
    .slice(0, k)
    .filter(([value]) => value >= MIN_SCORE)
    .map(([, i]) => SECTIONS[i]!)
}

export function bestSection(query: string): string | null {
  const found = search(query, 1)
  return found.length ? sectionText(found[0]!) : null
}
