import { redirect } from "next/navigation"

// Any unknown path redirects to the home page.
export default function NotFound() {
  redirect("/")
}
