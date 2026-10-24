import { redirect } from "next/navigation"

// Unknown paths go home, as the CRA router's <Navigate to="/" replace /> did.
export default function NotFound() {
  redirect("/")
}
