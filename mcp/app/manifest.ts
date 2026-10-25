import type { MetadataRoute } from "next";

/** Makes the dashboard installable (Add to Home Screen on phones, Install app on desktop Chrome/Edge). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Voicebox Studio",
    short_name: "Voicebox",
    description: "Your voice, studio-grade, and the shared desk where the two of you plan, make and post.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["productivity", "music", "social"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    shortcuts: [
      { name: "Posts", url: "/posts", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "New voiceover", url: "/voiceover", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Calendar", url: "/posts?view=calendar", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
