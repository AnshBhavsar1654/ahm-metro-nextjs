/**
 * Small pieces of Python behaviour the chatbot port depends on, so the TypeScript answers match the
 * FastAPI backend's word for word:
 *
 * - pyRegex: Python's `\b` is Unicode-aware (a Gujarati letter is a word character), JavaScript's
 *   is ASCII-only, even with the u flag. Patterns are written with `\b` as in rules.py and
 *   rewritten to explicit Unicode lookarounds.
 * - getCloseMatches: difflib.get_close_matches (SequenceMatcher ratio, same filters and order).
 * - pyJsonDumps: json.dumps(..., ensure_ascii=False) with Python's default ", " / ": " separators.
 * - pyFixed: f"{x:.Nf}" (round-half-even on the exact binary value; toFixed rounds ties up).
 */
import { pyRound } from "@/domain/metro/rounding"

const WORD = String.raw`[\p{L}\p{N}_]`
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`

/** A RegExp whose `\b` means what it means in Python 3 (Unicode word characters). */
export function pyRegex(source: string, flags: string = ""): RegExp {
  return new RegExp(source.replace(/\\b/g, BOUNDARY), flags.includes("u") ? flags : `${flags}u`)
}

/** f"{value:.{digits}f}" */
export function pyFixed(value: number, digits: number): string {
  return pyRound(value, digits).toFixed(digits)
}

/** str(value) for a Python float: 12.0 -> "12.0", 12.25 -> "12.25". */
export function pyFloatRepr(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

/** json.dumps(value, ensure_ascii=False). Every number is written as JavaScript would (no floats reach it). */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ")}}`
}

// ---------------------------------------------------------------- difflib

/** SequenceMatcher(None, a, b) for short strings (no junk, no autojunk: both need len(b) >= 200). */
class SequenceMatcher {
  private readonly b2j = new Map<string, number[]>()

  constructor(
    private readonly a: string[],
    private readonly b: string[],
  ) {
    b.forEach((ch, j) => {
      const list = this.b2j.get(ch)
      if (list) list.push(j)
      else this.b2j.set(ch, [j])
    })
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b } = this
    let [besti, bestj, bestsize] = [alo, blo, 0]
    let j2len = new Map<number, number>()
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>()
      for (const j of this.b2j.get(a[i]!) ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        newj2len.set(j, k)
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k]
      }
      j2len = newj2len
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      ;[besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1]
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++
    return [besti, bestj, bestsize]
  }

  private matches(): number {
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]]
    let total = 0
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi)
      if (!k) continue
      total += k
      if (alo < i && blo < j) queue.push([alo, i, blo, j])
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
    }
    return total
  }

  private static ratioOf(matches: number, length: number): number {
    return length ? (2.0 * matches) / length : 1.0
  }

  realQuickRatio(): number {
    const [la, lb] = [this.a.length, this.b.length]
    return SequenceMatcher.ratioOf(Math.min(la, lb), la + lb)
  }

  quickRatio(): number {
    const avail = new Map<string, number>()
    for (const ch of this.b) avail.set(ch, (avail.get(ch) ?? 0) + 1)
    let matches = 0
    for (const ch of this.a) {
      const n = avail.get(ch) ?? 0
      avail.set(ch, n - 1)
      if (n > 0) matches++
    }
    return SequenceMatcher.ratioOf(matches, this.a.length + this.b.length)
  }

  ratio(): number {
    return SequenceMatcher.ratioOf(this.matches(), this.a.length + this.b.length)
  }
}

/** difflib.get_close_matches(word, possibilities, n, cutoff): best first, ties by the larger string. */
export function getCloseMatches(word: string, possibilities: string[], n: number = 3, cutoff: number = 0.6): string[] {
  const b = Array.from(word)
  const scored: [number, string][] = []
  for (const x of possibilities) {
    const s = new SequenceMatcher(Array.from(x), b)
    if (s.realQuickRatio() >= cutoff && s.quickRatio() >= cutoff) {
      const ratio = s.ratio()
      if (ratio >= cutoff) scored.push([ratio, x])
    }
  }
  scored.sort((p, q) => (p[0] !== q[0] ? q[0] - p[0] : p[1] < q[1] ? 1 : p[1] > q[1] ? -1 : 0))
  return scored.slice(0, n).map(([, x]) => x)
}
