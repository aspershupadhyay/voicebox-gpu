// Moving what belongs on Backblaze (B2_PREFIXES in lib/store.ts) out of R2, once, when B2 is switched on: each file is
// copied, checked (same size on B2), and only then, with finish, R2's copy is deleted. Safe to run again: a file
// already on B2 at the same size is skipped. Runs from the storage tool (action move_to_b2).
import { B2_PREFIXES, b2Check, b2On, b2Ready, delR2, getR2, headB2, listR2, putB2, typeOf } from "./store";

export async function moveToB2({ finish = false, budgetMs = 25_000 } = {}) {
  if (!b2Ready()) throw new Error("Backblaze isn't set up on the Worker yet (B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT).");
  if (finish && !b2On()) throw new Error("Switch B2 on first (B2_FILES=on): until then new files still land in R2.");
  const check = await b2Check();
  if (!check.ok) return { moved: 0, error: "Backblaze turned the Worker's key down: nothing was copied or deleted.", check };
  const until = Date.now() + budgetMs;
  const all = (await Promise.all(B2_PREFIXES.map(listR2))).flat();
  let copied = 0, bytes = 0, already = 0;
  const safe: string[] = [], failed: { key: string; error: string }[] = [];
  for (const o of all) {
    if (Date.now() > until) break;
    try {
      if ((await headB2(o.key)) === o.size) { already++; safe.push(o.key); continue; }
      const src = await getR2(o.key);
      if (!src?.body) continue; // gone in between
      await putB2(o.key, src.body, src.headers.get("content-type") && src.headers.get("content-type") !== "application/octet-stream" ? src.headers.get("content-type")! : typeOf(o.key), o.size);
      if ((await headB2(o.key)) !== o.size) throw new Error("size differs after the copy");
      copied++; bytes += o.size; safe.push(o.key);
    } catch (e) { failed.push({ key: o.key, error: (e as Error).message }); }
  }
  if (finish && safe.length) await delR2(safe);
  const left = all.length - safe.length - failed.length;
  return {
    in_r2: all.length, copied, mb: +(bytes / 1e6).toFixed(1), already_on_b2: already,
    ...(finish ? { r2_copies_deleted: safe.length } : {}), failed, left,
    next: left ? "Run it again: the time ran out." : failed.length ? "Some failed: run it again." : finish ? "Done: R2 holds no files that belong on B2." : "Every file is on B2. Run again with finish: true to delete R2's copies.",
  };
}

/** Bring back to R2 what the first B2 version put on B2 but belongs on R2 (state .json files, the publish folder,
 *  thumbnails): copied when R2 hasn't got it, checked, then deleted from B2. Never overwrites R2 (2026-11-11: a run that
 *  did put an old Auto-DM settings file over the live one). Safe to run again. Runs from the storage tool (move_to_r2). */
export async function moveToR2({ budgetMs = 25_000 } = {}) {
  const S = await import("./store");
  if (!S.b2Ready()) throw new Error("Backblaze isn't set up on the Worker.");
  const until = Date.now() + budgetMs;
  const all = (await Promise.all(S.LEGACY_B2.map((p) => S.listB2(p)))).flat().filter((o) => S.legacyKey(o.key));
  let moved = 0, bytes = 0;
  const done: string[] = [], failed: { key: string; error: string }[] = [];
  for (const o of all) {
    if (Date.now() > until) break;
    try {
      // R2 already has it: R2's copy is the live one (it may be newer), so B2's is only deleted, never copied over it
      if ((await S.headR2(o.key)) === null) {
        const src = await S.b2Get(o.key);
        if (!src) { done.push(o.key); continue; }
        await S.putObj(o.key, new Uint8Array(await src.arrayBuffer()), src.headers.get("content-type") || S.typeOf(o.key));
        if ((await S.headR2(o.key)) !== o.size) throw new Error("size differs after the copy");
        moved++; bytes += o.size;
      }
      done.push(o.key);
    } catch (e) { failed.push({ key: o.key, error: (e as Error).message }); }
  }
  if (done.length) await S.delB2(done);
  const left = all.length - done.length - failed.length;
  return { on_b2: all.length, moved_to_r2: moved, mb: +(bytes / 1e6).toFixed(2), deleted_from_b2: done.length, failed, left,
    next: left ? "Run it again: the time ran out." : failed.length ? "Some failed (Backblaze's daily cap?): run it again later." : "Done: B2 holds only files people open." };
}
