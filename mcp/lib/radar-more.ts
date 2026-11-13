// Radar's wider net (2026-11-13, the owner: "add all of them which are no key ... make it palantir"). Every source here
// is free, needs no key and is read on the server alongside lib/radar-sources.ts's sweep. Each one answers on its own
// short limit and fails on its own (the Sources panel says which), so a slow site never holds the sweep up.
//
// Social: Bluesky's trends (with post counts) and its top posts on your seeds in the last day, Lemmy's front page,
// Wikipedia's recent changes (a page several people are editing right now),
// the App Store's top free apps and top podcasts. Crowds with money on it: Polymarket and Manifold by 24 h volume.
// Builders: Product Hunt's launches, Hugging Face's daily papers (upvoted) and trending Spaces, arXiv's new cs.AI / cs.CL papers, the week's
// downloads of the AI SDKs on npm and PyPI against their usual. Labs (the primary source the moment it lands): OpenAI,
// Google DeepMind, Google's AI blog and Hugging Face's blog feeds, and the sitemaps of Anthropic, Mistral and Nvidia's
// newsroom (pages added or changed in the last days, read as their slugs), and the newsrooms of Meta, Apple, Microsoft
// and Amazon. Status: Claude, OpenAI, GitHub and Cloudflare
// incidents. Power and money: GDELT (the world's press on your seeds, last day), the Federal Register (new US rules and
// presidential documents), SEC EDGAR full-text search (8-Ks naming a seed: exits, deals, results), the White House's
// sitemap, the European Commission, GOV.UK, UN News, the Pentagon and the WTO. Money: the Fed, the ECB, the RBI, the SEC
// and the CFTC, then Bloomberg Markets, the FT, the Economic Times and Mint. World and tech news: BBC, Al Jazeera, DW,
// The Guardian, France 24, the South China Morning Post, Nikkei Asia, TechCrunch, The Verge, Ars Technica, MIT Technology Review.
//
// Left out: Reddit and Metaculus (they refuse servers without a key), Kalshi (its open-market list is ~5 MB a read),
// NYT, Guardian API and the other free-key sources (docs/RADAR.md → "Sources").
// Sitemaps are read only where robots.txt allows it, at most a few files a sweep.
import type { SweepSignal } from "./radar";
import { strength } from "./radar";
import { STOP } from "./writing";
import { BOT, Track, json, pool, text } from "./radar-sources";

const D = 86_400_000;
const enc = encodeURIComponent;

/* ───────────── XML: RSS 2.0, RDF and Atom, and sitemaps */

const unesc = (s: string) => s.replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8217;/g, "’").replace(/&#8216;/g, "‘").replace(/&#822[01];/g, '"').replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/\s+/g, " ").trim();
const tg = (x: string, t: string) => { const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`).exec(x); return m ? unesc(m[1]) : ""; };
/** Every entry of a feed, whatever its dialect: title, link, time. */
export function entries(xml: string): { title: string; url: string; at: number }[] {
  const blocks = xml.split(/<(?:item|entry)(?=[\s>])[^>]*>/).slice(1).map((x) => x.split(/<\/(?:item|entry)>/)[0]);
  return blocks.map((b) => {
    const link = tg(b, "link") || (/<link[^>]*href="([^"]+)"/.exec(b)?.[1] ?? "") || tg(b, "guid");
    const when = tg(b, "pubDate") || tg(b, "dc:date") || tg(b, "published") || tg(b, "updated");
    return { title: tg(b, "title"), url: link.replace(/&amp;/g, "&"), at: Date.parse(when) || 0 };
  }).filter((e) => e.title && e.url);
}

/** robots.txt's rules for everyone (User-agent: *), enough to stay off what a site asks bots not to read. */
async function allowed(site: string, path: string): Promise<boolean> {
  try {
    const r = await text(`${site}/robots.txt`, { ms: 3000, ua: BOT });
    let mine = false; const dis: string[] = [];
    for (const raw of r.split("\n")) {
      const l = raw.split("#")[0].trim(); const [k, ...v] = l.split(":"); const val = v.join(":").trim();
      if (/^user-agent$/i.test(k)) mine = val === "*";
      else if (mine && /^disallow$/i.test(k) && val) dis.push(val);
    }
    // a rule is a path prefix where * is any run of characters and a final $ pins the end ("/*?s=" is only searches)
    const rx = (d: string) => new RegExp(`^${d.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    return !dis.some((d) => rx(d).test(path));
  } catch { return true; } // no robots.txt: nothing is asked
}

type SmUrl = { loc: string; at: number };
const smUrls = (xml: string): SmUrl[] => xml.split("<url>").slice(1).map((u) => ({ loc: tg(u, "loc"), at: Date.parse(tg(u, "lastmod")) || 0 }));
const smKids = (xml: string): SmUrl[] => xml.split("<sitemap>").slice(1).map((u) => ({ loc: tg(u, "loc"), at: Date.parse(tg(u, "lastmod")) || 0 }));
/** The pages a site added or changed in the last `days`, under the paths given, read from its sitemap (an index is
 *  followed into its newest one or two children whose name matches `kid`). The title is the page's slug in words. */
async function sitemap(site: string, o: { paths: RegExp; days: number; kid?: RegExp; file?: string }): Promise<{ title: string; url: string; at: number }[]> {
  const file = o.file ?? "/sitemap.xml";
  if (!(await allowed(site, file))) return [];
  const root = await text(site + file, { ms: 6000, ua: BOT });
  let urls = smUrls(root);
  const kids = smKids(root).filter((k) => !o.kid || o.kid.test(k.loc)).sort((a, b) => b.at - a.at).slice(0, 2);
  if (kids.length) urls = (await Promise.all(kids.map((k) => text(k.loc, { ms: 6000, ua: BOT }).then(smUrls).catch(() => [] as SmUrl[])))).flat();
  const since = Date.now() - o.days * D;
  return urls.filter((u) => u.at >= since && o.paths.test(new URL(u.loc).pathname)).sort((a, b) => b.at - a.at).slice(0, 15).map((u) => {
    const slug = new URL(u.loc).pathname.split("/").filter(Boolean).pop() ?? "";
    const words = decodeURIComponent(slug).replace(/-[0-9a-f]{4}$/, "").replace(/[-_]+/g, " ").replace(/\b(\w)/g, (m) => m.toUpperCase());
    return { title: `${new URL(site).hostname.replace(/^www\./, "")}: ${words}`, url: u.loc, at: u.at };
  });
}

/* ───────────── the sources */

const FEEDS = {
  labs: [
    "https://openai.com/news/rss.xml", "https://deepmind.google/blog/rss.xml", "https://blog.google/technology/ai/rss/", "https://huggingface.co/blog/feed.xml",
    "https://about.fb.com/news/feed/", "https://www.apple.com/newsroom/rss-feed.rss", "https://blogs.microsoft.com/feed/", "https://www.aboutamazon.com/news/rss",
  ],
  world: [
    "https://feeds.bbci.co.uk/news/world/rss.xml", "https://feeds.bbci.co.uk/news/business/rss.xml", "https://www.aljazeera.com/xml/rss/all.xml",
    "https://rss.dw.com/rdf/rss-en-all", "https://www.theguardian.com/world/rss", "https://www.france24.com/en/rss",
    "https://www.scmp.com/rss/91/feed", "https://asia.nikkei.com/rss/feed/nar",
  ],
  tech: [
    "https://techcrunch.com/feed/", "https://www.theverge.com/rss/index.xml", "https://feeds.arstechnica.com/arstechnica/index", "https://www.technologyreview.com/feed/",
  ],
  gov: [
    "https://ec.europa.eu/commission/presscorner/api/rss", "https://www.gov.uk/search/news-and-communications.atom", "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=10", "https://www.wto.org/library/rss/latest_news_e.xml",
  ],
  /** central banks and market regulators, then business desks (US, Europe, India) */
  money: [
    "https://www.federalreserve.gov/feeds/press_all.xml", "https://www.ecb.europa.eu/rss/press.html", "https://www.rbi.org.in/pressreleases_rss.xml",
    "https://www.sec.gov/news/pressreleases.rss", "https://www.cftc.gov/RSS/RSSGP/rssgp.xml",
    "https://feeds.bloomberg.com/markets/news.rss", "https://www.ft.com/rss/home", "https://economictimes.indiatimes.com/rssfeedsdefault.cms", "https://www.livemint.com/rss/news",
  ],
};
const SITEMAPS: { site: string; src: "labs" | "gov"; paths: RegExp; kid?: RegExp; file?: string }[] = [
  { site: "https://www.anthropic.com", src: "labs", paths: /^\/(news|research|engineering)\/./ },
  { site: "https://mistral.ai", src: "labs", paths: /^\/news\/./ },
  { site: "https://nvidianews.nvidia.com", src: "labs", paths: /^\/news\/./ },
  { site: "https://www.whitehouse.gov", src: "gov", paths: /^\/(presidential-actions|briefings-statements|fact-sheets|articles|remarks|releases)\//, kid: /post-sitemap/, file: "/sitemap_index.xml" },
];
const STATUS = [
  ["Claude", "https://status.claude.com/api/v2/summary.json"], ["OpenAI", "https://status.openai.com/api/v2/summary.json"],
  ["GitHub", "https://www.githubstatus.com/api/v2/summary.json"], ["Cloudflare", "https://www.cloudflarestatus.com/api/v2/summary.json"],
] as const;
/** The AI SDKs whose weekly downloads say what builders are picking up (npm, PyPI). */
const NPM = ["@anthropic-ai/sdk", "openai", "ai", "@modelcontextprotocol/sdk", "@google/genai", "langchain", "ollama", "@openai/agents"];
const PYPI = ["anthropic", "openai", "mcp", "google-genai", "langchain", "transformers", "vllm", "crewai", "litellm"];
const ITEMS_8K: Record<string, string> = { "1.01": "a material agreement", "1.02": "an agreement ended", "2.01": "an acquisition closed", "2.02": "results", "2.05": "layoffs or exit costs", "5.02": "an executive or director change", "5.07": "a shareholder vote", "7.01": "a disclosure", "8.01": "other news" };

const FILLER = new Set("has have had since first made make makes one two just now new more most over into from about after before than then also only very can will would could should still even back time year years day days week get got take takes says said like this that what when where which while".split(" "));
const fresh = <T extends { at: number }>(xs: T[], days: number) => xs.filter((x) => x.at && Date.now() - x.at <= days * D);
async function feedsOf(urls: string[], days: number, per: number) {
  // a feed with no dates at all (Nikkei Asia's) lists newest first: read its order as an hour apart
  const dated = (es: ReturnType<typeof entries>) => (es.some((e) => e.at) ? es : es.map((e, i) => ({ ...e, at: Date.now() - i * 3_600_000 })));
  return (await pool(urls, 4, (u) => text(u, { ms: 6000, ua: BOT }).then((x) => fresh(dated(entries(x)), days).slice(0, per).map((e) => ({ ...e, from: new URL(u).hostname.replace(/^(www|feeds|rss)\./, "") }))).catch(() => []))).flat();
}

/** The articles being edited again and again right now, by different people: Wikipedia's last ~1,000 human edits
 *  (its recent-changes list, about the last ten minutes) counted per article. A page several people are rewriting at
 *  once is usually a story breaking. */
async function editBurst(): Promise<{ title: string; n: number; users: number }[]> {
  type Rc = { query?: { recentchanges?: { title: string; user?: string }[] }; continue?: { rccontinue: string } };
  const base = "https://en.wikipedia.org/w/api.php?action=query&list=recentchanges&rcnamespace=0&rcshow=!bot&rctype=edit|new&rcprop=title|user&rclimit=500&format=json";
  const a = await json<Rc>(base, { ms: 5000, ua: BOT });
  const b = a.continue ? await json<Rc>(`${base}&rccontinue=${enc(a.continue.rccontinue)}`, { ms: 5000, ua: BOT }).catch(() => ({} as Rc)) : ({} as Rc);
  const n = new Map<string, { n: number; users: Set<string> }>();
  for (const e of [...(a.query?.recentchanges ?? []), ...(b.query?.recentchanges ?? [])]) {
    const c = n.get(e.title) ?? { n: 0, users: new Set<string>() }; c.n++; if (e.user) c.users.add(e.user); n.set(e.title, c);
  }
  return [...n].filter(([, c]) => c.n >= 3 && c.users.size >= 2).map(([title, c]) => ({ title, n: c.n, users: c.users.size })).sort((a, b) => b.users - a.users || b.n - a.n).slice(0, 15);
}

/** Every wider-net source at once; each fails on its own. */
export async function moreSignals(seeds: string[], g0: string, t: Track): Promise<SweepSignal[]> {
  const now = Date.now();
  const cc = g0.toLowerCase();
  // a seed that's only filler ("has", "since": the auto lane picks some from titles) would search SEC, Bluesky and GDELT for nothing
  const terms = seeds.map((s) => s.trim()).filter((s) => s.length >= 3 && !s.toLowerCase().split(/\s+/).every((w) => STOP.has(w) || FILLER.has(w))).slice(0, 6);
  type Bp = { uri: string; author: { handle: string }; record: { text?: string; createdAt?: string }; likeCount?: number; repostCount?: number };
  type Lm = { posts?: { post: { name: string; ap_id: string; url?: string; published: string }; counts: { score: number; comments: number }; community: { name: string } }[] };
  type Bt = { displayName: string; postCount?: number; startedAt?: string; status?: string; category?: string; link: string };
  type Hp = { title: string; paper: { id: string; upvotes?: number; publishedAt?: string } };
  type Hs = { id: string; likes: number; trendingScore?: number; createdAt?: string };
  type Ap = { feed?: { results?: { name: string; artistName: string; url: string; genres?: { name: string }[] }[] } };
  type Pm = { title: string; slug: string; volume24hr?: number };
  type Mf = { question: string; url: string; volume24Hours?: number; probability?: number };
  type St = { page: { name: string; url: string }; incidents?: { name: string; impact: string; shortlink?: string | null; created_at: string; status: string }[] };
  type Gd = { articles?: { url: string; title: string; seendate: string; domain: string; sourcecountry?: string }[] };
  type Fr = { results?: { title: string; html_url: string; publication_date: string; type: string; agencies?: { name: string }[] }[] };
  type Ef = { hits?: { hits?: { _id: string; _source: { ciks: string[]; display_names: string[]; file_date: string; items?: string[]; root_forms?: string[] } }[] } };
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const [bsky, bskyPosts, lemmy, launches, edits, apps, pods, poly, mani, papers, spaces, arxiv, npm, pypi, labsF, labsS, status, gdelt, fedreg, sec, gov, govS, money, world, tech] = await Promise.all([
    t.run("bluesky", async () => (await json<{ trends?: Bt[] }>("https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrends?limit=25", { ms: 5000, ua: BOT })).trends ?? [], [] as Bt[], (v) => v.length > 0),
    t.run("bluesky", async () => (await pool(terms.slice(0, 4), 2, (s) => json<{ posts?: Bp[] }>(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${enc(s)}&sort=top&limit=25&since=${new Date(now - D).toISOString()}`, { ms: 5000, ua: BOT }).then((r) => r.posts ?? []).catch(() => [] as Bp[]))).flat(), [] as Bp[]),
    t.run("lemmy", async () => (await json<Lm>("https://lemmy.world/api/v3/post/list?sort=Hot&limit=30&type_=All", { ms: 5000, ua: BOT })).posts ?? [], [] as NonNullable<Lm["posts"]>, (v) => v.length > 0),
    t.run("launches", async () => fresh(entries(await text("https://www.producthunt.com/feed", { ms: 6000, ua: BOT })), 2).slice(0, 30), [] as ReturnType<typeof entries>, (v) => v.length > 0),
    t.run("edits", () => editBurst(), [] as Awaited<ReturnType<typeof editBurst>>),
    t.run("apps", async () => (await json<Ap>(`https://rss.marketingtools.apple.com/api/v2/${cc}/apps/top-free/25/apps.json`, { ms: 8000, ua: BOT })).feed?.results ?? [], [] as NonNullable<NonNullable<Ap["feed"]>["results"]>, (v) => v.length > 0),
    t.run("podcasts", async () => (await json<Ap>(`https://rss.marketingtools.apple.com/api/v2/${cc}/podcasts/top/25/podcasts.json`, { ms: 8000, ua: BOT })).feed?.results ?? [], [] as NonNullable<NonNullable<Ap["feed"]>["results"]>, (v) => v.length > 0),
    t.run("markets", () => json<Pm[]>("https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=25", { ms: 5000, ua: BOT }), [] as Pm[], (v) => v.length > 0),
    t.run("markets", () => json<Mf[]>("https://api.manifold.markets/v0/search-markets?sort=24-hour-vol&limit=25", { ms: 5000, ua: BOT }), [] as Mf[]),
    t.run("papers", () => json<Hp[]>("https://huggingface.co/api/daily_papers?limit=30", { ms: 5000, ua: BOT }), [] as Hp[], (v) => v.length > 0),
    t.run("spaces", () => json<Hs[]>("https://huggingface.co/api/spaces?sort=trendingScore&limit=20", { ms: 5000, ua: BOT }), [] as Hs[], (v) => v.length > 0),
    t.run("papers", async () => fresh(entries(await text("https://rss.arxiv.org/rss/cs.AI+cs.CL", { ms: 6000, ua: BOT })), 3).slice(0, 30), [] as ReturnType<typeof entries>),
    t.run("packages", async () => (await pool(NPM, 4, async (p) => {
      const r = await json<{ downloads: { downloads: number; day: string }[] }>(`https://api.npmjs.org/downloads/range/last-month/${p}`, { ms: 5000, ua: BOT }).catch(() => null);
      const d = (r?.downloads ?? []).filter((x) => x.downloads > 0).map((x) => x.downloads); // npm leaves days at 0 while it counts
      if (d.length < 14) return null;
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      return { pkg: p, week: Math.round(avg(d.slice(-7)) * 7), ratio: avg(d.slice(-7)) / avg(d.slice(0, -7)) };
    })).filter((x): x is NonNullable<typeof x> => !!x), [] as { pkg: string; week: number; ratio: number }[]),
    t.run("packages", async () => (await pool(PYPI, 4, async (p) => {
      const r = await json<{ data: { last_week: number; last_month: number } }>(`https://pypistats.org/api/packages/${p}/recent`, { ms: 5000, ua: BOT }).catch(() => null);
      if (!r?.data?.last_month) return null;
      return { pkg: p, week: r.data.last_week, ratio: r.data.last_week / (r.data.last_month / (30 / 7)) };
    })).filter((x): x is NonNullable<typeof x> => !!x), [] as { pkg: string; week: number; ratio: number }[]),
    t.run("labs", () => feedsOf(FEEDS.labs, 4, 8), [] as Awaited<ReturnType<typeof feedsOf>>, (v) => v.length > 0),
    t.run("labs", async () => (await Promise.all(SITEMAPS.filter((s) => s.src === "labs").map((s) => sitemap(s.site, { paths: s.paths, days: 4, kid: s.kid, file: s.file }).catch(() => [])))).flat(), [] as Awaited<ReturnType<typeof sitemap>>),
    t.run("status", async () => (await Promise.all(STATUS.map(([name, u]) => json<St>(u, { ms: 5000, ua: BOT }).then((s) => (s.incidents ?? []).map((i) => ({ ...i, who: name, page: s.page.url }))).catch(() => [])))).flat(), [] as (NonNullable<St["incidents"]>[number] & { who: string; page: string })[]),
    t.run("gdelt", async () => {
      if (!terms.length) return [];
      const q = terms.length > 1 ? `(${terms.map((s) => (s.includes(" ") ? `"${s}"` : s)).join(" OR ")})` : terms[0].includes(" ") ? `"${terms[0]}"` : terms[0];
      return (await json<Gd>(`https://api.gdeltproject.org/api/v2/doc/doc?query=${enc(`${q} sourcelang:english`)}&mode=artlist&format=json&maxrecords=50&timespan=1d&sort=hybridrel`, { ms: 12000, ua: BOT })).articles ?? [];
    }, [] as NonNullable<Gd["articles"]>),
    t.run("policy", async () => (await json<Fr>(`https://www.federalregister.gov/api/v1/documents.json?per_page=30&order=newest&conditions[type][]=RULE&conditions[type][]=PRORULE&conditions[type][]=PRESDOCU&fields[]=title&fields[]=html_url&fields[]=publication_date&fields[]=type&fields[]=agencies`, { ms: 6000, ua: BOT })).results ?? [], [] as NonNullable<Fr["results"]>, (v) => v.length > 0),
    t.run("filings", async () => (await pool(terms.slice(0, 4), 2, (s) => json<Ef>(`https://efts.sec.gov/LATEST/search-index?q=${enc(`"${s}"`)}&forms=8-K&dateRange=custom&startdt=${ymd(now - 4 * D)}&enddt=${ymd(now)}`, { ms: 6000, ua: BOT }).then((r) => r.hits?.hits ?? []).catch(() => []))).flat(), [] as NonNullable<NonNullable<Ef["hits"]>["hits"]>),
    t.run("policy", () => feedsOf(FEEDS.gov, 3, 10), [] as Awaited<ReturnType<typeof feedsOf>>),
    t.run("policy", async () => (await Promise.all(SITEMAPS.filter((s) => s.src === "gov").map((s) => sitemap(s.site, { paths: s.paths, days: 3, kid: s.kid, file: s.file }).catch(() => [])))).flat(), [] as Awaited<ReturnType<typeof sitemap>>),
    t.run("money", () => feedsOf(FEEDS.money, 3, 10), [] as Awaited<ReturnType<typeof feedsOf>>, (v) => v.length > 0),
    t.run("world", () => feedsOf(FEEDS.world, 2, 12), [] as Awaited<ReturnType<typeof feedsOf>>, (v) => v.length > 0),
    t.run("tech", () => feedsOf(FEEDS.tech, 2, 12), [] as Awaited<ReturnType<typeof feedsOf>>, (v) => v.length > 0),
  ]);

  const impactW: Record<string, number> = { critical: 1, major: 0.85, minor: 0.55, none: 0.35 };
  const seen = new Set<string>(); // an 8-K is often found by several seeds, a filing has several exhibits: once each
  return [
    ...bsky.map((x) => ({ src: "bluesky" as const, title: x.displayName, url: `https://bsky.app${x.link}`, at: Date.parse(x.startedAt ?? "") || now, w: strength.bluesky(x.postCount ?? 0), metric: `${(x.postCount ?? 0).toLocaleString("en")} posts${x.status === "hot" ? " · hot" : ""}` })),
    ...bskyPosts.filter((p) => (p.likeCount ?? 0) >= 30 && p.record.text).map((p) => ({ src: "bluesky" as const, title: (p.record.text ?? "").replace(/\s+/g, " ").slice(0, 160), url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split("/").pop()}`, at: Date.parse(p.record.createdAt ?? "") || now, w: strength.likes(p.likeCount ?? 0), metric: `${(p.likeCount ?? 0).toLocaleString("en")} likes · ${(p.repostCount ?? 0).toLocaleString("en")} reposts` })),
    ...lemmy.map((x) => ({ src: "lemmy" as const, title: x.post.name, url: x.post.url || x.post.ap_id, at: Date.parse(x.post.published) || now, w: strength.lemmy(x.counts.score), metric: `${x.counts.score} points · ${x.community.name}` })),
    ...launches.map((x) => ({ src: "launches" as const, title: x.title, url: x.url, at: x.at, w: 0.4, metric: "launched on Product Hunt" })),
    ...edits.map((x) => ({ src: "edits" as const, title: x.title, url: `https://en.wikipedia.org/wiki/${enc(x.title.replace(/ /g, "_"))}`, at: now, w: strength.edits(x.n), metric: `${x.n} edits by ${x.users} people in ~10 min` })),
    ...apps.map((x, i) => ({ src: "apps" as const, title: `${x.name} · ${x.artistName}`, url: x.url, at: now, w: strength.rank(i), metric: `#${i + 1} free app (${g0})` })),
    ...pods.map((x, i) => ({ src: "podcasts" as const, title: `${x.name} · ${x.artistName}`, url: x.url, at: now, w: strength.rank(i) * 0.7, metric: `#${i + 1} podcast (${g0})` })),
    ...poly.map((x) => ({ src: "markets" as const, title: x.title, url: `https://polymarket.com/event/${x.slug}`, at: now, w: strength.markets(x.volume24hr ?? 0), metric: `$${Math.round(x.volume24hr ?? 0).toLocaleString("en")} bet in 24 h` })),
    ...mani.map((x) => ({ src: "markets" as const, title: x.question, url: x.url, at: now, w: strength.markets((x.volume24Hours ?? 0) / 10) * 0.8, metric: `${Math.round(x.volume24Hours ?? 0).toLocaleString("en")} mana in 24 h${x.probability != null ? ` · ${Math.round(x.probability * 100)}%` : ""}` })),
    ...papers.map((x) => ({ src: "papers" as const, title: x.title, url: `https://huggingface.co/papers/${x.paper.id}`, at: Date.parse(x.paper.publishedAt ?? "") || now, w: strength.papers(x.paper.upvotes ?? 0), metric: `${x.paper.upvotes ?? 0} upvotes` })),
    ...arxiv.map((x) => ({ src: "papers" as const, title: x.title, url: x.url, at: x.at, w: 0.15, metric: "new on arXiv" })),
    ...spaces.map((x) => { const [org, name] = x.id.split("/"); return { src: "spaces" as const, title: `${(name ?? org).replace(/[-_]/g, " ")} ${org}`, url: `https://huggingface.co/spaces/${x.id}`, at: Date.parse(x.createdAt ?? "") || now, w: strength.hf(x.likes), metric: `${x.likes.toLocaleString("en")} likes · trending ${x.trendingScore ?? 0}` }; }),
    ...[...npm.map((x) => ({ ...x, reg: "npm" })), ...pypi.map((x) => ({ ...x, reg: "PyPI" }))].filter((x) => x.ratio >= 1.15).map((x) => ({
      src: "packages" as const, title: `${x.pkg.replace(/^@/, "").replace(/[/_-]/g, " ")} downloads up`, url: x.reg === "npm" ? `https://www.npmjs.com/package/${x.pkg}` : `https://pypi.org/project/${x.pkg}/`, at: now,
      w: strength.growth(x.ratio), metric: `${x.reg}: ${x.week.toLocaleString("en")} this week, ${Math.round((x.ratio - 1) * 100)}% over the usual`,
    })),
    ...labsF.map((x) => ({ src: "labs" as const, title: x.title, url: x.url, at: x.at, w: 0.6, metric: x.from })),
    ...labsS.map((x) => ({ src: "labs" as const, title: x.title, url: x.url, at: x.at, w: 0.5, metric: "new or changed page" })),
    ...status.filter((x) => x.status !== "resolved" && x.status !== "postmortem").map((x) => ({ src: "status" as const, title: `${x.who} outage: ${x.name}`, url: x.shortlink || x.page, at: Date.parse(x.created_at) || now, w: impactW[x.impact] ?? 0.5, metric: `${x.impact} impact · ${x.status}` })),
    ...gdelt.map((x) => ({ src: "gdelt" as const, title: x.title, url: x.url, at: Date.parse(x.seendate.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, "$1-$2-$3T$4:$5:$6Z")) || now, w: 0.3, metric: `${x.domain}${x.sourcecountry ? ` · ${x.sourcecountry}` : ""}` })),
    ...fedreg.map((x) => ({ src: "policy" as const, title: x.title, url: x.html_url, at: Date.parse(x.publication_date) || now, w: x.type === "Presidential Document" ? 0.6 : 0.4, metric: `Federal Register · ${x.type}${x.agencies?.[0] ? ` · ${x.agencies[0].name}` : ""}` })),
    ...gov.map((x) => ({ src: "policy" as const, title: x.title, url: x.url, at: x.at, w: 0.45, metric: x.from })),
    ...govS.map((x) => ({ src: "policy" as const, title: x.title, url: x.url, at: x.at, w: 0.5, metric: "new or changed page" })),
    ...sec.flatMap((h) => {
      const [adsh, file] = h._id.split(":"); if (seen.has(adsh)) return []; seen.add(adsh);
      const who = (h._source.display_names[0] ?? "").replace(/\s+\(CIK.*$/, "");
      const what = (h._source.items ?? []).map((i) => ITEMS_8K[i]).filter(Boolean).slice(0, 2).join(", ") || "a filing";
      const cik = String(+h._source.ciks[0]);
      return [{ src: "filings" as const, title: `${who}: 8-K, ${what}`, url: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${file}`, at: Date.parse(h._source.file_date) || now, w: (h._source.items ?? []).includes("5.02") ? 0.65 : 0.4, metric: `SEC EDGAR · ${h._source.file_date}` }];
    }),
    ...money.map((x) => ({ src: "money" as const, title: x.title, url: x.url, at: x.at, w: /federalreserve|ecb\.europa|rbi\.org|sec\.gov|cftc/.test(x.url) ? 0.5 : 0.3, metric: x.from })),
    ...world.map((x) => ({ src: "world" as const, title: x.title, url: x.url, at: x.at, w: 0.3, metric: x.from })),
    ...tech.map((x) => ({ src: "tech" as const, title: x.title, url: x.url, at: x.at, w: 0.3, metric: x.from })),
  ];
}
