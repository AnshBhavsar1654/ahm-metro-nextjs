import { Suspense } from "react"
import Stations from "@/components/Stations"

export default function StationsPage() {
  return (
    <Suspense>
      <Stations />
    </Suspense>
  )
}
