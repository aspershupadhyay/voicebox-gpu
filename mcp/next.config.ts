import type { NextConfig } from "next";

// Browser hardening on every response: HTTPS only (2 years), never framed by another site (clickjacking), no MIME
// sniffing, no full URLs leaked to other sites, and only the features the studio uses (the microphone, for recording).
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // the old page addresses (bookmarks, the MCP tools' links, the installed app) land on their new homes
  async redirects() {
    const to = (source: string, destination: string) => ({ source, destination, permanent: false });
    return [
      to("/generate", "/voiceover"), to("/studio", "/clean-up"), to("/image", "/images"), to("/health", "/gpu"),
      to("/content", "/posts"), to("/workspace", "/posts?view=board"), to("/calendar", "/posts?view=calendar"),
      to("/library", "/files"), to("/media", "/files?tab=uploads"), to("/board", "/posts?view=board"),
    ];
  },
};
export default config;
