import type { Metadata, Viewport } from "next"
import { cookies, headers } from "next/headers"
import ChatWidget from "@/components/ChatWidget"
import Footer from "@/components/Footer"
import Navbar from "@/components/Navbar"
import { I18nProvider } from "@/i18n"
import { LANGUAGE_KEY, pickLanguage } from "@/i18n/languages"
import { THEME_KEY, type Theme } from "@/lib/preferences"
import { ThemeProvider } from "@/lib/theme"
import "./globals.css"

export const metadata: Metadata = {
  title: "Ahmedabad Metro",
  description: "Ahmedabad Metro - Your gateway to efficient urban transportation in Ahmedabad, Gujarat",
  icons: { icon: "/logo.png", apple: "/logo.png" },
  manifest: "/manifest.json",
}

export const viewport: Viewport = { themeColor: "#FAFBF8" }

// Sets the theme class before the first paint (no flash), from the rider's choice or the operating system.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='dark'&&t!=='light')t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.classList.toggle('dark',t==='dark')}catch(e){}})()`

const FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Devanagari:wght@400;500;600;700&family=Noto+Sans+Gujarati:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies()
  const saved = jar.get(THEME_KEY)?.value
  const theme: Theme | null = saved === "dark" || saved === "light" ? saved : null
  const lang = pickLanguage(jar.get(LANGUAGE_KEY)?.value, (await headers()).get("accept-language"))

  return (
    <html lang={lang} className={theme === "dark" ? "dark" : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href={FONTS} rel="stylesheet" />
      </head>
      <body>
        <ThemeProvider initialTheme={theme}>
          <I18nProvider initialLang={lang}>
            <div className="flex min-h-screen flex-col">
              <Navbar />
              <main className="flex-1 pt-16">{children}</main>
              <Footer />
              <ChatWidget />
            </div>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
