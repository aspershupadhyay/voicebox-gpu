import type { MetadataRoute } from "next";

/** Makes the dashboard installable (Add to Home Screen on phones, Install app on desktop Chrome/Edge). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "voicebox studio",
    short_name: "voicebox",
    description: "Your voice, studio-grade, and the shared desk where the two of you plan, make and post.",
    id: "/",
    start_url: "/workspace",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    categories: ["productivity", "music", "social"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    shortcuts: [
      { name: "Board", url: "/workspace", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "New voiceover", url: "/generate", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Calendar", url: "/calendar", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
