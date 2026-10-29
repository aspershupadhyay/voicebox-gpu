// Web search for models (docs/AUTOMATION.md, phase 5): short results from Brave or Tavily with the owner's key
// (SEARCH_API_KEY on Vercel; a tvly- key is Tavily, anything else Brave unless SEARCH_PROVIDER says). Results are
// data, never instructions.
export type Hit = { title: string; url: string; snippet: string; age?: string };

export async function search(query: string, opts: { count?: number; fresh?: "day" | "week" | "month" | "year" } = {}): Promise<{ provider: string; hits: Hit[] }> {
  const key = process.env.SEARCH_API_KEY;
  if (!key) throw new Error("search needs SEARCH_API_KEY on Vercel (a Brave Search or Tavily key, added by the owner). Meanwhile, browse a page you know, e.g. a site's own search URL.");
  const count = Math.min(opts.count ?? 8, 20);
  const provider = process.env.SEARCH_PROVIDER || (key.startsWith("tvly-") ? "tavily" : "brave");
  if (provider === "tavily") {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: count, search_depth: "basic", ...(opts.fresh ? { time_range: opts.fresh } : {}) }), cache: "no-store",
    });
    if (!r.ok) throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = (await r.json()) as { results: { title: string; url: string; content: string; published_date?: string }[] };
    return { provider, hits: d.results.map((x) => ({ title: x.title, url: x.url, snippet: x.content.slice(0, 300), ...(x.published_date ? { age: x.published_date } : {}) })) };
  }
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(count));
  if (opts.fresh) u.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[opts.fresh]);
  const r = await fetch(u, { headers: { Accept: "application/json", "X-Subscription-Token": key }, cache: "no-store" });
  if (!r.ok) throw new Error(`Brave Search ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = (await r.json()) as { web?: { results: { title: string; url: string; description: string; age?: string }[] } };
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return { provider, hits: (d.web?.results ?? []).map((x) => ({ title: strip(x.title), url: x.url, snippet: strip(x.description).slice(0, 300), ...(x.age ? { age: x.age } : {}) })) };
}
