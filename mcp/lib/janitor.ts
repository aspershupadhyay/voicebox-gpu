// Keeping the R2 bucket to what matters (the owner, 2026-11-10: "why is R2 growing, it shouldn't hold cache after the
// work is done"). What the bucket holds that nothing needs once the work is over goes here, every night (the backup
// knock) and when a project finishes with purge:
//   - the motion tools' cache (cache/toolchain/): a runtime that needs a tool installs it again (a few minutes, once)
//   - the vLLM compile cache (cache/compile/<gpu>/<version>/): only the newest version per GPU stays (a fresh runtime
//     compiles from scratch without it, which costs GPU time on every start)
//   - a download's staging (workspace/downloads/<id>/) once the download is no longer running
//   - temporary uploads (uploads/) older than a day
//   - a file's bytes, poster and photo thumbnails once its row is gone (deleted before this ran, or a half-finished
//     upload older than a day)
//   - the call log past 31 days (it's read back 31 days at most)
// The caches are left alone while a GPU is working, so a runtime never loses a cache it's reading.
import { createHash } from "node:crypto";
import { delObjs, listObjs, type StoredObj } from "./store";

const DAY = 864e5;
const thumbOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 24);

type Found = { what: string; keys: string[]; bytes: number };

async function busyGpu() {
  const g = await import("./gpus");
  const s = await g.gpuState();
  return s.colab.online || g.CLOUDS.some((c) => s[c].awake && ((s[c].rec?.running ?? 0) > 0 || (s[c].rec?.queue ?? 0) > 0));
}

/** What can go, by kind, without deleting anything. */
export async function findWaste(now = Date.now()): Promise<{ gpu_busy: boolean; found: Found[] }> {
  const pick = (what: string, objs: StoredObj[]): Found => ({ what, keys: objs.map((o) => o.key), bytes: objs.reduce((n, o) => n + o.size, 0) });
  const [toolchain, compile, staging, uploads, media, posters, thumbs, logs, gpuBusy] = await Promise.all([
    listObjs("cache/toolchain/"), listObjs("cache/compile/"), listObjs("workspace/downloads/"), listObjs("uploads/"),
    listObjs("workspace/media/"), listObjs("workspace/posters/"), listObjs("cache/thumbs/"), listObjs("auto/log/"),
    busyGpu().catch(() => true), // can't tell: assume it's working
  ]);
  const found: Found[] = [];

  if (!gpuBusy) {
    found.push(pick("motion tools cache (cache/toolchain)", toolchain));
    // cache/compile/<gpu>/<version>/...: the newest version per GPU stays
    const newest = new Map<string, { v: string; at: number }>();
    for (const o of compile) {
      const [, , gpu, v] = o.key.split("/");
      const cur = newest.get(gpu);
      if (!cur || o.modified > cur.at) newest.set(gpu, { v, at: o.modified });
    }
    found.push(pick("older compile caches (cache/compile)", compile.filter((o) => { const [, , gpu, v] = o.key.split("/"); return newest.get(gpu)?.v !== v; })));
  }

  const { listDownloads } = await import("./downloads");
  const running = new Set((await listDownloads()).filter((d) => ["fetching", "waiting", "worker", "saving"].includes(d.status)).map((d) => d.id));
  found.push(pick("download staging (workspace/downloads)", staging.filter((o) => {
    const id = /^workspace\/downloads\/([^/]+)\//.exec(o.key)?.[1];
    return !!id && !running.has(id); // cookies.txt sits beside them, not inside one
  })));
  found.push(pick("temporary uploads (uploads)", uploads.filter((o) => now - o.modified > DAY)));

  // bytes whose file is gone: every row's key, straight from the database
  const { hasDb, sql } = await import("./db");
  if (hasDb()) {
    const rows = (await sql().query("select id, r2_key from media")) as { id: string; r2_key: string | null }[];
    const live = new Set(rows.map((r) => r.r2_key).filter(Boolean) as string[]);
    const ids = new Set(rows.map((r) => r.id));
    const hashes = new Set([...live].map(thumbOf));
    found.push(pick("files with no row (workspace/media)", media.filter((o) => !live.has(o.key) && now - o.modified > DAY)));
    found.push(pick("posters of deleted files (workspace/posters)", posters.filter((o) => {
      const id = /^workspace\/posters\/m_(.+)\.jpg$/.exec(o.key)?.[1];
      return !!id && !ids.has(id);
    })));
    found.push(pick("thumbnails of deleted photos (cache/thumbs)", thumbs.filter((o) => {
      const h = /^cache\/thumbs\/([0-9a-f]{24})-/.exec(o.key)?.[1];
      return !!h && !hashes.has(h);
    })));
  }

  const cutoff = new Date(now - 31 * DAY).toISOString().slice(0, 10);
  found.push(pick("call log past 31 days (auto/log)", logs.filter((o) => (o.key.split("/")[2] ?? "9") < cutoff)));
  return { gpu_busy: gpuBusy, found: found.filter((f) => f.keys.length) };
}

/** Delete what findWaste finds. Answers what went, by kind, and how much. */
export async function cleanStorage() {
  const { gpu_busy, found } = await findWaste();
  for (const f of found) for (let i = 0; i < f.keys.length; i += 500) await delObjs(f.keys.slice(i, i + 500));
  const { storageUse } = await import("./r2files");
  const after = await storageUse(true).catch(() => null);
  return {
    deleted: found.map((f) => ({ what: f.what, files: f.keys.length, mb: +(f.bytes / 1e6).toFixed(1) })),
    freed_mb: +(found.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1),
    ...(gpu_busy ? { note: "A GPU is working, so its caches were left for now; they go on the next clean-up after it stops." } : {}),
    ...(after ? { used_gb: +(after.bytes / 1e9).toFixed(2), budget_gb: +(after.cap / 1e9).toFixed(2) } : {}),
  };
}

/** Once a day (after 03:00 UTC, after the backup), from the backup knock: one knock takes the day's turn. */
export async function nightlyClean() {
  if (new Date().getUTCHours() < 3) return null;
  const { getJsonTagged, putJson, putJsonIf } = await import("./store");
  const day = new Date().toISOString().slice(0, 10);
  const { value, etag } = await getJsonTagged<{ day: string }>("auto/janitor.json");
  if (value?.day === day || !(await putJsonIf("auto/janitor.json", { day }, etag))) return null;
  const out = await cleanStorage();
  await putJson("auto/janitor.json", { day, at: Date.now(), ...out });
  return out;
}
