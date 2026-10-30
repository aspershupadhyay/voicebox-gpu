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
  // The MCP SDK picks its schema checker by runtime: Ajv on Node (it writes code at run time, which Cloudflare Workers
  // forbid), @cfworker/json-schema on workerd. Use the Workers one everywhere, so the same build runs on both
  // (docs/MIGRATION.md step 3).
  turbopack: { resolveAlias: { "@modelcontextprotocol/server/_shims": "./node_modules/@modelcontextprotocol/server/dist/shimsWorkerd.mjs" } },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // the old page addresses (bookmarks, the MCP tools' links, the installed app) land on their new homes
  async redirects() {
    const to = (source: string, destination: string) => ({ source, destination, permanent: false });
    return [
      to("/generate", "/voiceover"), to("/studio", "/clean-up"), to("/image", "/images"), to("/health", "/settings?tab=gpu"),
      to("/content", "/posts"), to("/workspace", "/posts?view=board"), to("/calendar", "/posts?view=calendar"),
      to("/library", "/files"), to("/media", "/files?tab=uploads"), to("/board", "/posts?view=board"),
      to("/model", "/voices/professional"),
      // the studio opens on Grow (Home lives at /home), and GPU & engines is a Settings tab
      to("/", "/analytics"), to("/gpu", "/settings?tab=gpu"),
      // Analytics' platform tabs became views with their own addresses
      ...(["youtube", "instagram"] as const).map((t) => ({ ...to("/analytics", `/analytics/${t}`), has: [{ type: "query" as const, key: "tab", value: t }] })),
    ];
  },
};
export default config;
