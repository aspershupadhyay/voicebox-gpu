// End-to-end checks for Auto-DM: the real engine (lib/publish/autodm*.ts, dmstore.ts) against PGlite (real Postgres in
// WASM) with R2, accounts, Instagram, notify and Claude stubbed. Nothing leaves the machine.
// Run from mcp/:  npm i --no-save @electric-sql/pglite && npx tsx scripts/check-autodm.cts
/* eslint-disable */
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const MCP = path.resolve(__dirname, "..");
const R = (p: string) => require.resolve(path.join(MCP, p));
const stub = (p: string, exports: any) => { const f = R(p); require.cache[f] = { id: f, filename: f, loaded: true, exports } as any; };

const pg = new PGlite();
const ns = require.resolve("next/server", { paths: [MCP] });
const afters: Promise<unknown>[] = [];
require.cache[ns] = { id: ns, filename: ns, loaded: true, exports: { after: (f: () => Promise<unknown>) => { afters.push(f()); } } } as any;
const calls: { kind: string; [k: string]: any }[] = [];
const store = new Map<string, string>();
let tagN = 0;
stub("lib/db.ts", { sql: () => ({ query: async (q: string, v: unknown[]) => (await pg.query(q, v)).rows }), hasDb: () => true, listRows: async () => [] });
stub("lib/store.ts", {
  getJson: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
  putJson: async (k: string, v: unknown) => { store.set(k, JSON.stringify(v)); },
  getJsonTagged: async (k: string) => ({ value: store.has(k) ? JSON.parse(store.get(k)!) : null, etag: store.has(k) ? String(tagN) : null }),
  putJsonIf: async (k: string, v: unknown) => { store.set(k, JSON.stringify(v)); tagN++; return true; },
  delObjs: async (ks: string[]) => { for (const k of ks) store.delete(k); },
  listObjs: async () => [],
});
const ACC = { id: "17841400000000001", network: "instagram", handle: "catchtheerror", name: "Catch", scopes: ["instagram_business_manage_messages"], dm_subscribed: 1 };
stub("lib/publish/accounts.ts", { listAccounts: async () => [ACC], getAccount: async (id: string) => (id === ACC.id ? { ...ACC, tokens: {} } : null), patchAccount: async () => null });
stub("lib/publish/instagram.ts", {
  accessToken: async () => "TOKEN",
  reply: async (_t: string, c: string, m: string) => { calls.push({ kind: "public", comment: c, text: m }); return { id: "r1" }; },
  hideComment: async (_t: string, c: string, h: boolean) => { calls.push({ kind: h ? "hide" : "unhide", comment: c }); return {}; },
  deleteComment: async (_t: string, c: string) => { calls.push({ kind: "delete", comment: c }); return {}; },
  igGet: async (p: string) => { calls.push({ kind: "igget", p }); return p.includes("/media") ? { data: [{ id: "900001", caption: "New drop. Comment PROMPT and I'll send it https://x.dev/p", media_type: "VIDEO", media_product_type: "REELS" }, { id: "900002", caption: "Comment CATCH for the link", media_product_type: "REELS" }] } : { caption: "The Rewind reel caption" }; },
  subscribeApp: async () => ({}),
});
const notes: string[] = [];
stub("lib/colab.ts", { notify: async (t: string, b: string) => { notes.push(`${t}: ${b}`); return true; }, appOrigin: () => "" });
stub("lib/publish/plans.ts", { getPlan: async () => null, listPlans: async () => [] });
stub("lib/data.ts", { getPost: async (id: string) => ({ $id: id, title: "Rewind", script: "Line one of the Rewind script.\nIt takes 40 seconds.", caption: "Comment CATCH", notes: "link https://prompt-motion.com/stephanlivera-df17a2", link: null }) });
stub("lib/auto/secrets.ts", { secret: async () => "sk-ant-test-key-1234567890", secretsStatus: async () => ({ anthropic: { from: "dashboard", last4: "7890" } }) });
let aiReply = "It's 40 seconds long, and the link has the full prompt.";
const aiReqs: any[] = [];
const sdk = R("node_modules/@anthropic-ai/sdk/index.js");
class FakeAnthropic { beta = { messages: { create: async (req: any) => { aiReqs.push(req); return { stop_reason: "end_turn", content: [{ type: "text", text: aiReply }] }; } } }; }
require.cache[sdk] = { id: sdk, filename: sdk, loaded: true, exports: { default: FakeAnthropic, __esModule: true } } as any;

// Instagram's send API and the sync address
let following: boolean | null = true;
const sends: { to: any; message: any }[] = [];
const synced: any[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  if (u.startsWith("https://graph.instagram.com") && u.includes("/messages")) { const b = JSON.parse(init.body); sends.push({ to: b.recipient, message: b.message }); return new Response(JSON.stringify({ recipient_id: b.recipient.id ?? "PSID1", message_id: "m" })); }
  if (u.includes("is_user_follow_business")) return new Response(JSON.stringify(following === null ? {} : { is_user_follow_business: following }));
  if (u.startsWith("https://api.anthropic.com/v1/messages")) {
    const req = JSON.parse(init.body); req.__beta = (init.headers instanceof Headers ? init.headers.get("anthropic-beta") : new Headers(init.headers).get("anthropic-beta")); aiReqs.push(req);
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: req.model, stop_reason: "end_turn", content: [{ type: "text", text: aiReply }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json", "request-id": "r" } });
  }
  if (u.startsWith("https://hook.test")) { synced.push(JSON.parse(init.body)); return new Response("ok"); }
  throw new Error(`unexpected fetch ${u}`);
};
process.env.INSTAGRAM_DM = "1"; process.env.INSTAGRAM_APP_SECRET = "s".repeat(32); process.env.APP_URL = "https://studio.test";

let fails = 0, passes = 0;
const ok = (c: any, m: string) => { if (c) { passes++; console.log("  ✓", m); } else { fails++; console.log("  ✗", m); } };
const section = (s: string) => console.log(`\n${s}`);
const last = () => sends[sends.length - 1];
const textOf = (m: any) => m?.text ?? m?.attachment?.payload?.text ?? "";
const btnsOf = (m: any) => m?.attachment?.payload?.buttons ?? [];
let n = 0;
const comment = (text: string, from = "c1", user = "fan_one", media = "900002") => ({ object: "instagram", entry: [{ id: ACC.id, changes: [{ field: "comments", value: { id: `cm${++n}`, text, from: { id: from, username: user }, media: { id: media } } }] }] });
const dm = (text: string, from = "PSID1", extra: any = {}) => ({ object: "instagram", entry: [{ id: ACC.id, messaging: [{ sender: { id: from }, recipient: { id: ACC.id }, message: { mid: `mid${++n}`, text, ...extra } }] }] });
const tap = (payload: string, from = "PSID1") => ({ object: "instagram", entry: [{ id: ACC.id, messaging: [{ sender: { id: from }, recipient: { id: ACC.id }, postback: { mid: `pb${++n}`, payload, title: "x" } }] }] });

(async () => {
  const M = require(path.join(MCP, "lib/publish/dmmatch.ts"));
  const Core = require(path.join(MCP, "lib/publish/autodm.ts"));
  const More = require(path.join(MCP, "lib/publish/autodm-more.ts"));
  const DB = require(path.join(MCP, "lib/publish/dmstore.ts"));
  const q = async (s: string, v: unknown[] = []) => (await pg.query(s, v)).rows as any[];
  const reset = async () => { sends.length = 0; calls.length = 0; synced.length = 0; notes.length = 0; await pg.query("delete from autodm_events"); await pg.query("delete from autodm_leads"); };
  await DB.ensure();
  await Core.setGeneral({ on: true }, "test");
  const save = async (a: any) => (await Core.saveAutomation({ on: true, keywords: ["CATCH"], message: "Here's the prompt 🎬", button: { label: "Open the prompt", url: "https://prompt-motion.com/stephanlivera-df17a2" }, public_replies: ["Sent! Check your DMs 📩"], ...a }, "test")).automation;
  const only = async (a: any) => { await Core.mutate((s: any) => { s.automations = []; }); return save(a); };

  section("1. Link click tracking");
  {
    const url = Core.trackUrl(123, 0), tok = url.split("/l/")[1];
    ok(url.startsWith("https://studio.test/l/"), `short link ${url}`);
    ok(JSON.stringify(Core.readTrack(tok)) === '{"id":123,"k":0}', "reads back its row and link");
    ok(Core.readTrack(tok.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"))) === null, "a changed signature is refused");
    ok(Core.readTrack(tok.replace(/^3f/, "3g")) === null, "another row with the same signature is refused");
    await reset(); const a = await only({ track: true });
    await Core.onWebhook(comment("catch pls"));
    const b = btnsOf(last()?.message)[0];
    ok(b?.type === "web_url" && b.url.startsWith("https://studio.test/l/"), "the DM's button goes through the short link");
    const route = require(path.join(MCP, "app/l/[token]/route.ts"));
    const t = b.url.split("/l/")[1];
    const r1 = await route.GET(new Request(b.url, { headers: { "user-agent": "facebookexternalhit/1.1" } }), { params: Promise.resolve({ token: t }) });
    let [row] = await q("select clicks, clicked_at from autodm_events where automation = $1", [a.id]);
    ok(r1.status === 302 && row.clicks === 0, "Instagram's link preview is sent on, not counted");
    const r2 = await route.GET(new Request(b.url, { headers: { "user-agent": "Mozilla/5.0 (iPhone) Instagram 300" } }), { params: Promise.resolve({ token: t }) });
    [row] = await q("select clicks, clicked_at from autodm_events where automation = $1", [a.id]);
    ok(r2.status === 302 && r2.headers.get("location") === "https://prompt-motion.com/stephanlivera-df17a2" && row.clicks === 1 && row.clicked_at, "a tap redirects to the saved link and counts");
    const r3 = await route.GET(new Request("https://studio.test/l/zz"), { params: Promise.resolve({ token: "1-0-AAAAAAAAAAAA" }) });
    ok(r3.status === 404, "a forged token is a 404");
    const st = await DB.stats(30);
    ok(st[a.id].sent === 1 && st[a.id].clicked === 1, "stats: 1 sent, 1 opened");
  }

  section("2. Auto-attach on publish");
  {
    ok(M.keywordFrom("💬 Want the prompt? Comment CATCH and we'll DM you the link.") === "CATCH", "keyword from the Rewind caption: CATCH");
    ok(M.keywordFrom('Type "prompt" below') === "PROMPT", "quoted keyword");
    ok(M.keywordFrom("Drop a comment below if you liked it") === null, "'drop a comment below' is not a keyword");
    ok(M.keywordFrom("comment below what you think") === null, "'comment below' is not a keyword");
    ok(M.keywordFrom("DM me GUIDE for the guide") === "GUIDE", "DM me GUIDE");
    await reset(); await Core.mutate((s: any) => { s.automations = []; });
    const tpl = await save({ name: "Template", on: false, keywords: ["X"], message: "Here's {title} 👇", match: "fuzzy" });
    await Core.setGeneral({ auto_attach: { on: true, template: tpl.id, live: true } }, "t");
    const plan = { post: "post1", space: "ig_reel", account: ACC.id, result: { id: "777001", url: "u", at: 1 }, ig: { caption: "Rewind it. Comment CATCH and we'll DM you the link." } };
    const made = await More.onPublished(plan);
    ok(made && made.keywords[0] === "CATCH" && made.media[0].id === "777001" && made.on, "made, live, on the new reel, keyword CATCH");
    ok(made.button.url === "https://prompt-motion.com/stephanlivera-df17a2" && made.message === "Here's Rewind 👇", "link from the post's notes, {title} filled");
    ok((await More.onPublished(plan)) === null, "never twice for the same post");
    ok(notes.some((x) => x.includes("answering your new post")), "pushes a notification");
    const sug = await More.suggest();
    ok(sug.length === 2 && sug[0].keyword === "PROMPT" && sug[0].link === "https://x.dev/p" && sug[1].keyword === "CATCH", "caption scan: PROMPT and CATCH on posts nothing answers yet");
    ok((await More.createSuggested([sug[0]], "t")) === 1 && (await Core.getSettings()).automations[0].keywords[0] === "PROMPT" && !(await Core.getSettings()).automations[0].on, "creates it from the template, switched off");
    await Core.saveAutomation({ name: "Every post CATCH", on: true, keywords: ["CATCH"], message: "m", where: "all" }, "t");
    ok((await More.suggest()).length === 0, "an every-post automation covers the rest");
    await Core.setGeneral({ auto_attach: { on: false } }, "t");
  }

  section("3. Multi-step flows (choices)");
  {
    await reset();
    const a = await only({ button: null, message: "Want the prompt or the tutorial?", choices: [{ label: "The prompt", reply: "Here's the prompt", button: { label: "Open", url: "https://a.test/p" } }, { label: "The tutorial", reply: "Here's the tutorial: https://a.test/t" }] });
    ok(Core.problems(a).length === 0, "valid with two choices");
    await Core.onWebhook(comment("CATCH"));
    const m = last().message, bs = btnsOf(m);
    ok(last().to.comment_id && bs.length === 2 && bs.every((b: any) => b.type === "postback" && /^vbdc:/.test(b.payload)), "a private reply with 2 choice buttons");
    await Core.onWebhook(tap(bs[1].payload, "PSID1"));
    ok(last().to.id === "PSID1" && textOf(last().message) === "Here's the tutorial: https://a.test/t", "tapping 'The tutorial' answers with its reply");
    await Core.onWebhook(tap(bs[0].payload, "PSID1"));
    ok(textOf(last().message) === "Here's the prompt" && btnsOf(last().message)[0].url.includes("/l/") && btnsOf(last().message)[0].url.includes("-1-"), "'The prompt' sends its own tracked link (link 1)");
    const before = sends.length;
    await Core.onWebhook(tap(bs[0].payload.replace(/.$/, "x"), "PSID1"));
    ok(sends.length === before, "a forged tap does nothing");
    const bad = Core.cleanAutomation({ message: "x", keywords: ["a"], button: { label: "L", url: "https://x.y" }, choices: [{ label: "1", reply: "r" }, { label: "2", reply: "r" }, { label: "3", reply: "r" }] });
    ok(Core.problems(bad).some((p: string) => p.includes("up to 3 buttons")), "4 buttons is refused");
  }

  section("4. Collect emails in DMs");
  {
    ok(M.emailIn("sure it's Me.Name+x@Mail.com.") === "me.name+x@mail.com", "an email inside a sentence");
    await reset(); await Core.setGeneral({ sync: { on: true, url: "https://hook.test/x", leads: true } }, "t");
    await only({ collect: { on: true, when: "after" } });
    await Core.onWebhook(comment("catch", "c9", "fan_nine"));
    ok(textOf(last().message).includes("Reply with your email"), "after: the question rides in the private reply");
    await Core.onWebhook(dm("yes! fan@nine.com", "PSID1"));
    const ls = await DB.leads({});
    ok(ls.length === 1 && ls[0].email === "fan@nine.com" && ls[0].from_name === "fan_nine", "the email is saved as a lead");
    ok(textOf(last().message).startsWith("Got it, thanks fan_nine"), "and thanked");
    ok(synced.some((s) => s.type === "lead" && s.email === "fan@nine.com"), "and synced to the sheet");
    await reset();
    await only({ collect: { on: true, when: "before", ask: "First, your email?" } });
    await Core.onWebhook(comment("catch", "c10", "fan_ten"));
    ok(textOf(last().message) === "First, your email?" && btnsOf(last().message).length === 0, "before: asks first, no DM yet");
    await Core.onWebhook(dm("hmm what", "PSID1"));
    const n1 = sends.length;
    await Core.onWebhook(dm("ten@fan.io", "PSID1"));
    ok(sends.length === n1 + 1 && textOf(last().message).includes("Got it") && textOf(last().message).includes("Here's the prompt"), "the email unlocks the DM (thanks + the DM in one)");
    const [r] = await q("select status, awaiting from autodm_events where kind = 'comment' order by id desc limit 1");
    ok(r.status === "sent" && r.awaiting === null, "row is sent, not waiting");
    await Core.setGeneral({ sync: { on: false } }, "t");
  }

  section("5. Story mention replies");
  {
    await reset();
    await only({ keywords: [], triggers: { comments: false, mentions: true }, message: "Thanks for the mention {username}! 🙏", button: null });
    await Core.onWebhook(dm("", "PSID7", { attachments: [{ type: "story_mention", payload: { url: "https://cdn/x" } }] }));
    ok(last()?.to.id === "PSID7" && textOf(last().message).startsWith("Thanks for the mention"), "a story mention gets the thank-you DM");
    const [r] = await q("select kind, status from autodm_events order by id desc limit 1");
    ok(r.kind === "mention" && r.status === "sent", "logged as a mention");
  }

  section("6. A/B test DMs");
  {
    ok(More.abWinner({ a: { sent: 100, clicked: 10 }, b: { sent: 100, clicked: 30 } }, 50) === "b", "30% vs 10% over 100 each: B wins");
    ok(More.abWinner({ a: { sent: 100, clicked: 20 }, b: { sent: 100, clicked: 22 } }, 50) === null, "20% vs 22%: keep testing");
    ok(More.abWinner({ a: { sent: 40, clicked: 1 }, b: { sent: 40, clicked: 30 } }, 50) === null, "under the minimum: keep testing");
    ok(More.abWinner({ a: { sent: 260, clicked: 52 }, b: { sent: 250, clicked: 55 } }, 50) === "b", "after 10× min with no clear winner: the higher one");
    await reset();
    const a = await only({ ab: { on: true, message: "Version B 🔥", button_label: "Get it", min: 10 } });
    for (let i = 0; i < 40; i++) await Core.onWebhook(comment("catch", `ab${i}`, `u${i}`));
    const v = await DB.variants(a.id);
    ok(v.a.sent + v.b.sent === 40 && v.a.sent > 5 && v.b.sent > 5, `split ${v.a.sent}/${v.b.sent}`);
    ok(sends.some((s) => textOf(s.message) === "Version B 🔥" && btnsOf(s.message)[0].title === "Get it"), "B goes out with its own button text");
    await pg.query("update autodm_events set clicked_at = now(), clicks = 1 where variant = 'b'");
    ok((await More.decideAb(a.id)) === "b", "B clicked far more: B wins");
    const after = (await Core.getSettings()).automations[0];
    ok(after.ab.winner === "b" && Core.variantOf(after) === "b", "everyone gets B now");
    const changed = Core.cleanAutomation({ ab: { message: "New B" } }, after);
    ok(changed.ab.winner === null, "a changed B starts the test again");
  }

  section("7. Sheets/CRM sync and the weekly report");
  {
    await Core.setGeneral({ sync: { on: true, url: "https://hook.test/s", dms: true } }, "t");
    await reset(); await only({});
    await Core.onWebhook(comment("catch", "s1", "syncer"));
    ok(synced.some((s) => s.type === "dm" && s.username === "syncer" && s.account === "catchtheerror"), "sent DMs sync when chosen");
    await DB.addLead({ account: ACC.id, from_id: "x", from_name: "lead1", email: "l@x.io", automation: null, automation_name: null, event: null });
    const r = await More.syncNow("all");
    ok(r.ok && synced.some((s) => s.type === "leads" && s.leads.length === 1), "send every email collected so far");
    let threw = false; try { await Core.setGeneral({ sync: { url: "http://insecure.test" } }, "t"); } catch { threw = true; }
    ok(threw, "an http:// sync address is refused");
    await Core.setGeneral({ sync: { on: false } }, "t");
    const rep = await More.weekly();
    ok(rep.now.sent >= 1 && rep.text.includes("DMs sent") && notes.some((x) => x.startsWith("Auto-DM this week")), `report: "${rep.text}"`);
    ok((await More.lastReport()).at === rep.at, "saved for the Insights tab");
    const d = new Date(Date.UTC(2026, 10, 2, 4)); // a Monday, 04:00 UTC
    ok(More.reportDue({ on: true, day: 1, last: 0 }, d) && !More.reportDue({ on: true, day: 1, last: d.getTime() - 3600e3 }, d) && !More.reportDue({ on: true, day: 2, last: 0 }, d), "due on its day once");
    const ins = await More.insights(30);
    ok(ins.daily.length === 30 && typeof ins.now.people === "number" && ins.prev && Array.isArray(ins.top), "insights: totals, previous, 30 days, top");
  }

  section("8. Spam safety");
  {
    await reset(); await only({});
    await Core.setGeneral({ block: ["@Spammy.Bot"] }, "t");
    await Core.onWebhook(comment("catch", "b1", "spammy.bot"));
    const [b] = await q("select status, note from autodm_events order by id desc limit 1");
    ok(b.status === "skipped" && /Blocked/.test(b.note) && sends.length === 0, "a blocked username gets nothing");
    await Core.setGeneral({ unblock: ["spammy.bot"], safety: { per_hour: 2 } }, "t");
    for (let i = 0; i < 4; i++) await Core.onWebhook(comment("catch", `h${i}`, `hour${i}`));
    const held = await q("select count(*)::int n from autodm_events where status = 'held'");
    ok(sends.length === 2 && held[0].n === 2 && store.has("workspace/publish/autodm/held.json"), "over 2 an hour: 2 sent, 2 held, the sweep's marker set");
    await Core.setGeneral({ safety: { per_hour: 10 } }, "t");
    const sw = await More.sweep();
    ok(sw.sent === 2 && sends.length === 4 && !store.has("workspace/publish/autodm/held.json"), "the sweep sends the held ones when there's room, then clears the marker");
    await Core.setGeneral({ safety: { per_hour: 150, per_person_day: 1 } }, "t");
    await Core.mutate((s: any) => { s.automations[0].once_per_person = false; });
    await Core.onWebhook(comment("catch again", "h0", "hour0"));
    const [p] = await q("select status, note from autodm_events order by id desc limit 1");
    ok(p.status === "skipped" && /Daily limit/.test(p.note), "one person's daily limit");
    await Core.setGeneral({ safety: { per_person_day: 5 } }, "t");
  }

  section("9. AI replies");
  {
    await reset(); await only({ ai: { on: true, notes: "The film is 40 seconds." }, posts: [{ id: "post1", label: "Rewind" }], where: "all" });
    await Core.onWebhook(comment("catch", "ai1", "curious"));
    await Core.onWebhook(dm("how long is the video?", "PSID1"));
    ok(textOf(last().message) === aiReply && last().to.id === "PSID1", "a follow-up question gets Claude's answer");
    const req = aiReqs[aiReqs.length - 1];
    ok(req.model === "claude-opus-5-5" && req.fallbacks === "default" && String(req.__beta).includes("server-side-fallback-2026-07-01") && req.output_config.effort === "low", "opus-5-5, server-side fallbacks, low effort");
    ok(req.system.includes("Line one of the Rewind script") && req.system.includes("The film is 40 seconds.") && req.system.includes("Here's the prompt"), "context: the post's script, the notes, the DM");
    ok(req.messages[0].role === "user" && req.messages[req.messages.length - 1].role === "user" && req.messages[req.messages.length - 1].content.includes("how long"), `turns alternate and end with theirs (${req.messages.map((m: any) => m.role).join(",")})`);
    aiReply = "[HANDOFF] Good question, the creator will reply personally.";
    await Core.onWebhook(dm("can I pay you to make one for my brand?", "PSID1"));
    const [h] = await q("select kind, note, reply from autodm_events order by id desc limit 1");
    ok(h.kind === "ai" && /Needs you/.test(h.note) && !h.reply.includes("[HANDOFF]") && notes.some((x) => x.includes("needs you")), "a handoff: marked Needs you, marker stripped, notified");
    const before = aiReqs.length;
    await Core.onWebhook(dm("hello?", "PSID_STRANGER"));
    ok(aiReqs.length === before, "someone no automation wrote to gets no AI answer");
    aiReply = "It's 40 seconds long, and the link has the full prompt.";
    const t = await More.aiTest((await Core.getSettings()).automations[0].id, "is it free?");
    ok(t.answer === aiReply, "the editor's AI test answers without sending");
  }

  section("10. Comment rules");
  {
    ok(M.modMatch({ words: ["scam"], match: "word", links: false }, "this is a SCAM!!") === "scam", "word match");
    ok(M.modMatch({ words: [], match: "word", links: true }, "check my page bit.ly/xx") === "a link", "links");
    ok(M.modMatch({ words: ["scam"], match: "word", links: false }, "scampi is great") === null, "not inside other words");
    await reset(); await only({});
    await Core.setGeneral({ moderation: { on: true, rules: [{ name: "Scams", words: ["scam", "crypto"], action: "hide" }, { name: "Review", words: ["refund"], action: "flag" }] } }, "t");
    await Core.onWebhook(comment("catch crypto giveaway", "m1", "scammer"));
    ok(calls.some((c) => c.kind === "hide") && sends.length === 0, "hidden, and gets no DM");
    await Core.onWebhook(comment("catch, also refund?", "m2", "asker"));
    ok(!calls.some((c) => c.kind === "hide" && c.comment !== calls.find((x) => x.kind === "hide")!.comment) && sends.length === 1, "flagged: stays up, still gets the DM");
    const queue = await DB.activity({ kind: "mod" });
    ok(queue.length === 2 && queue.some((x: any) => x.status === "hidden") && queue.some((x: any) => x.status === "flagged"), "both in the review list");
    const hid = queue.find((x: any) => x.status === "hidden");
    await More.modAct(hid.id, "unhide");
    ok(calls.some((c) => c.kind === "unhide") && (await DB.getEvent(hid.id)).status === "dismissed", "show it again");
    ok(!(await DB.activity({})).some((x: any) => x.kind === "mod"), "the DM log leaves rule actions out");
    await Core.setGeneral({ on: false }, "t");
    await Core.onWebhook(comment("scam", "m3", "x"));
    ok(calls.filter((c) => c.kind === "hide").length === 2, "rules work even with Auto-DM switched off");
  }

  section("Totals and contacts SQL");
  {
    const t = await DB.totals(30), t2 = await DB.totals(7, 7);
    ok(typeof t.people === "number" && t2.sent === 0, "totals windows");
    const c = await DB.contacts({});
    ok(Array.isArray(c) && c.length > 0, "contacts");
    const top = await DB.top(7, 5);
    ok(Array.isArray(top), "top");
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
