"use client"

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams as useNextSearchParams } from "next/navigation"

type ParamsInit = URLSearchParams | Record<string, string>

/**
 * react-router's useSearchParams on top of Next's router: [params, setParams(next, { replace })].
 * Changing the query never scrolls the page.
 */
export function useSearchParams(): [URLSearchParams, (next: ParamsInit, options?: { replace?: boolean }) => void] {
  const current = useNextSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const query = current.toString()
  const params = useMemo(() => new URLSearchParams(query), [query])
  const setParams = useCallback(
    (next: ParamsInit, options?: { replace?: boolean }) => {
      const search = new URLSearchParams(next).toString()
      const url = search ? `${pathname}?${search}` : pathname
      if (options?.replace) router.replace(url, { scroll: false })
      else router.push(url, { scroll: false })
    },
    [pathname, router],
  )
  return [params, setParams]
}
