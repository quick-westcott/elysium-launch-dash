import type { Metadata } from "next"
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google"
import { DemoBanner } from "@/components/demo-banner"
import { Providers } from "@/components/providers"
import { TopBar } from "@/components/top-bar"
import { Toaster } from "@/components/ui/toast"
import { BRAND } from "@/lib/brand"
import "./globals.css"

// The docs site's fonts: Space Grotesk for text, IBM Plex Mono for addresses, hashes and code.
const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" })
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" })

const DESCRIPTION = BRAND.description
const NAME = BRAND.tag.replace("starter", "launcher")
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? BRAND.live),
  openGraph: { type: "website", siteName: "TrenchyTools", title: `${NAME} · TrenchyTools`, description: DESCRIPTION, images: [{ url: "/og.png", width: 1280, height: 640, alt: NAME }] },
  twitter: { card: "summary_large_image", site: "@trenchytools", title: `${NAME} · TrenchyTools`, description: DESCRIPTION, images: ["/og.png"] },
  title: { default: `${BRAND.tag} · TrenchyTools`, template: `%s · ${BRAND.tag}` },
  description: DESCRIPTION,
  icons: { icon: "/icon.svg" },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="bg-background text-foreground min-h-dvh font-sans antialiased">
        <Providers>
          <TopBar />
          <DemoBanner />
          <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 sm:px-6">{children}</main>
          <Toaster />
        </Providers>
      </body>
    </html>
  )
}
