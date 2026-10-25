import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif" });

export const metadata: Metadata = {
  title: { default: "Voicebox Studio", template: "%s · Voicebox Studio" },
  description: "Your voice, studio-grade, and the shared desk where the two of you plan, make and post.",
  robots: { index: false, follow: false },
  applicationName: "Voicebox Studio",
  appleWebApp: { capable: true, title: "Voicebox", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0a" },
  ],
};

// Applies the saved theme before first paint (no flash), and registers the service worker that makes this installable.
const boot = `try{var t=localStorage.getItem("vb-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}
if("serviceWorker"in navigator&&location.protocol==="https:")addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: boot }} /></head>
      <body>{children}</body>
    </html>
  );
}
