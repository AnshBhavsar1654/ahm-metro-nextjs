import "./globals.css"

export const metadata = {
  title: "Ahmedabad Metro",
  description: "Routes, fares, stations and schedules for the Ahmedabad-Gandhinagar Metro.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        {/* Navbar, Footer and ChatWidget arrive in Phase 7; the shell matches App.jsx's structure. */}
        <main className="flex-1">{children}</main>
      </body>
    </html>
  )
}
