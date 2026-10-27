// The GPU worker's cache across runtimes (worker/r2cache.py): model weights mirrored from Hugging Face and vLLM's
// compiled kernels per GPU, kept in R2 under cache/. The worker holds no storage keys; it gets presigned links here,
// with the same secret as the heartbeat, and only for keys under cache/.
import { presign } from "@/lib/store";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";

const KEY = /^cache\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/){1,4}[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || !safeEqual(token, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { op?: string; keys?: unknown; method?: string } | null;
  if (body?.op !== "sign") return Response.json({ error: "op must be sign" }, { status: 400 });
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const method = body.method === "PUT" ? "PUT" : "GET";
  if (!keys.length || keys.length > 200 || !keys.every((k) => typeof k === "string" && KEY.test(k) && !k.includes("..")))
    return Response.json({ error: "keys: 1-200 paths under cache/" }, { status: 400 });
  try {
    const urls = Object.fromEntries(await Promise.all((keys as string[]).map(async (k) => [k, await presign(k, method, 2 * 3600)] as const)));
    return Response.json({ urls }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
