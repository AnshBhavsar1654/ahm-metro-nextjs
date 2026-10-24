import { Suspense } from "react"
import { RoutesInfo } from "@/components/client-only"

export default function RoutesPage() {
  return (
    <Suspense>
      <RoutesInfo />
    </Suspense>
  )
}
