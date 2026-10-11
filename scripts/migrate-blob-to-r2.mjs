#!/usr/bin/env node
// One-off: copy everything from the old (suspended) Vercel Blob store into the R2 bucket, same pathnames.
// Run once Blob allows reads again (it was suspended for going over the Hobby plan's operation limits):
//
//   t=$(mktemp -d) && (cd $t && npm i -s @vercel/blob aws4fetch) && \
//   (cd mcp && npx vercel env pull $t/.env --environment production --yes) && \
//   NODE_PATH=$t/node_modules node --env-file=$t/.env --env-file=.secrets.local scripts/migrate-blob-to-r2.mjs
//
// Skips objects already in R2 with the same size. Safe to re-run.
import { createRequire } from "node:module";
const require = createRequire(process.env.NODE_PATH + "/");
const { list, get } = require("@vercel/blob");
const { AwsClient } = require("aws4fetch");

const r2 = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
const base = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET || "voicebox"}`;
const url = (k) => `${base}/${k.split("/").map(encodeURIComponent).join("/")}`;

let cursor, copied = 0, skipped = 0, failed = 0;
do {
  const page = await list({ cursor, limit: 1000 });
  for (const b of page.blobs) {
    if (b.pathname === "voicebox/worker.json") continue; // live heartbeat, rewritten every minute anyway
    const head = await r2.fetch(url(b.pathname), { method: "HEAD" });
    if (head.ok && Number(head.headers.get("content-length")) === b.size) { skipped++; continue; }
    try {
      const r = await get(b.pathname, { access: "private", useCache: false });
      if (!r || r.statusCode !== 200) throw new Error(`blob ${r?.statusCode}`);
      const body = Buffer.from(await new Response(r.stream).arrayBuffer());
      const put = await r2.fetch(url(b.pathname), { method: "PUT", body, headers: { "Content-Type": r.blob.contentType || "application/octet-stream" } });
      if (!put.ok) throw new Error(`r2 ${put.status}`);
      copied++;
      if (copied % 25 === 0) console.log(`${copied} copied…`);
    } catch (e) {
      failed++;
      console.log(`FAILED ${b.pathname}: ${e.message}`);
    }
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
console.log(`done: ${copied} copied, ${skipped} already there, ${failed} failed`);
process.exit(failed ? 1 : 0);
