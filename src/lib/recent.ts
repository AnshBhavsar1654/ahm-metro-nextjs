// Recent journeys, kept in this browser only (like the "favourites" on TMB and Tokyo Metro's apps).
const KEY = "metro_recent_journeys"
const MAX = 5

export type Journey = { from: string; to: string }

export const loadRecent = (): Journey[] => {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]")
    return Array.isArray(list) ? (list as Journey[]).filter((j) => j && j.from && j.to).slice(0, MAX) : []
  } catch {
    return []
  }
}

export const saveRecent = (from: string, to: string): Journey[] => {
  const list = [{ from, to }, ...loadRecent().filter((j) => !(j.from === from && j.to === to))].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable: the list just won't persist */
  }
  return list
}

export const clearRecent = (): Journey[] => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
  return []
}
