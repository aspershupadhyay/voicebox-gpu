# Radar: the plan to make it the research tool creators stop paying for

The owner's ask (2026-10-29): make Radar the Palantir of content research, as good as or better than the paid tools
(vidIQ, TubeBuddy, 1of10, ViewStats, Exploding Topics, Glimpse), useful to any creator, built only on free data. It
should feel like a different world inside our theme, clean and organised, and nobody should wonder what a button does.

This file is the plan, in order. Tick `docs/ROADMAP.md` → Radar as each step lands. One pull request per step, each
measured against the rules at the bottom.

## 1. Where Radar is today (read from the owner's screenshots)

What works: real sources, scores that list their parts, a confidence, a prediction with a track record, a watchlist.

What makes it confusing:

1. **Two scores for the same thing.** In Sweep, "apple" is *Go now, Score 100, Heat 100, Fit 100*. In Keyword it is
   *Strong, Opportunity 63*. Same topic, same day, two verdicts and two scales. People can't trust either.
2. **Everything is 100.** Score, heat, fit, autocomplete depth, long tail, views a day: all 100. A score that's always
   at the top tells you nothing. The scales need calibrating so 100 is rare.
3. **Codes you have to decode.** `H100 F100 C:H S06` in the readout, `LANE SCAN`, `SEARCH 00`. The telemetry look is
   right but the meaning isn't on screen.
4. **"Higher is harder"** on Competition flips the direction of one card out of four. Everything else is "higher is
   better".
5. **Clipped facts.** "YouTube 10, …", "547,0…", "2 hits (Varun Mayy…": the evidence is the valuable part and it's cut.
6. **The lane is single words.** "faster, came, free, insane, code" are words from titles, not topics. "came" and
   "insane" aren't a lane.
7. **Three tabs that are three different jobs** (Sweep = discover, Keyword = investigate, Watchlist = track), each with
   its own layout and its own Watch / Ask Claude / Research buttons, so the same action lives in four places.
8. **The prediction says "Your median 8 yt_short posts get 34 views"**: an internal id (`yt_short`) on screen.
9. The **"Opportunity" label sits on the rings** (fixed in this pull request: it's under the dial now).

## 2. The idea: one object, three moves

Palantir's trick isn't the dark screen: it's that everything is an **object** you can open, and every object links to
the others (a person → their calls → the places). For us the object is a **Topic** (a keyword or a trend; they're the
same thing at different stages), linked to:

- the **sources** that mention it (news, HN, Bluesky, YouTube trending, autocomplete…),
- the **videos** that rank for it and the **channels** behind them (rivals or not),
- the **searches** around it (long tail, questions, "vs" pairs),
- **your posts** on it and the **predictions** made for them,
- its **history** (our own daily snapshots, Wikipedia, GDELT).

Radar then has exactly three moves, and every screen says which one you're on:

| Move | Question it answers | Screen |
| --- | --- | --- |
| **Brief** | What should I make this week? | The Brief (the default) |
| **Investigate** | Is this topic worth it, and how do I win it? | The Dossier (one per topic) |
| **Track** | Is it still worth it, and was I right? | Watch (watchlist + alerts + track record) |

Explore (the scope and the full table) is how you browse into a Dossier; it sits under Brief, not beside it.

### One score, everywhere

- **Bet** (0–100) with a verdict: **Go now** (≥ 80 and momentum rising), **Strong** (65–79), **Maybe** (45–64),
  **Skip** (< 45). The scope, the table, the Dossier, the watchlist, the MCP tools and Ask Claude all show the same number
  for the same topic on the same read.
- Its four parts, **all higher-is-better**: **Demand** (people look for it), **Momentum** (it's rising),
  **Room** (the inverse of competition: small or old results on top means room), **Fit** (it suits you).
- **Confidence** stays separate (high / medium / low) and says why ("6 independent sources, 66% from the last two days").
- **Calibrated, not capped.** Each part is a percentile against a reference set of ~500 keywords we re-read weekly,
  so 100 means "top 1% of what we've seen", not "the source returned a lot". Expect most topics between 30 and 80.

### Words on screen

- No ids or codes without words next to them: `yt_short` → "Short", `H84` → "Heat 84".
- Every number has a "why" on hover and on tap (what it's made of, which sources answered, when it was read).
- Evidence rows wrap to two lines instead of clipping; the full value is in the row's tooltip and the Dossier.
- One action bar per object, always in the same place and order: **Research it** (primary) · **Watch** · **Make a
  post** · **Ask Claude** (in the ⋯ when space is tight).

## 3. The look: an operations room in our theme

Same matte black, Geist, hairlines, no gradients (`docs/DESIGN.md`). What makes it feel like a different world:

- **A command bar on top** instead of a search box: one field ("Research a topic, a channel or a video link…") with
  type-ahead from the autocompletes, recent topics and the watchlist. ⌘K jumps into it from anywhere in Radar.
- **Bracketed panels.** Every panel has the corner brackets the scope already has, a mono kicker (`BRIEF · 29 OCT`,
  `DOSSIER · APPLE`) and a one-line plain sub. The kicker is decoration; the sub is the meaning.
- **A status rail at the bottom** (one hairline row, mono, 11px): sources answering (14/16), last sweep, next sweep,
  YouTube quota left, cache age. Click it to see the sources grid. This replaces "read 43m ago" floating in a corner.
- **A timeline scrubber** under the scope and in each Dossier: 30 / 90 / 365 days of our own snapshots, Wikipedia and
  GDELT; drag to see the radar as it was.
- **A link graph** in the Dossier (small, quiet): the topic in the middle, rivals and videos and searches around it,
  each a node you can open. Built with SVG, the same dot style as the scope.
- **Motion only for live things**: the beam, a new signal arriving, a number ticking. Everything else rises in once.
- **Colour means state, nothing else**: green Go now, blue Strong, amber Maybe, grey Skip, red only for a source that
  failed or an alert. The current screens use red for "Competition 82", which reads as an error.

### The Brief (desktop)

```
┌ BRIEF · THU 29 OCT ─────────────────────────────── [ Research a topic, channel or link…  ⌘K ] ┐
│ What to make this week, from 16 free sources and your own numbers                             │
├───────────────────────────────────────────────┬───────────────────────────────────────────────┤
│ FIVE BETS                                     │ ┌ SCOPE ┐                                    │
│ 01  apple macbook neo   Go now  82  ▲ +14     │ │   (the radar, quieter: only the top 12    │
│     Short · 2.5× your usual · 64% to beat it  │ │    topics labelled, sectors by source)    │
│ 02  claude code agents  Strong  74  ▲ +6      │ │                                           │
│ 03  …                                         │ └───────────────────────────────────────────┘
├───────────────────────────────────────────────┴───────────────────────────────────────────────┤
│ SINCE YESTERDAY   3 new · 2 rising fast · 1 cooling · rival @varun posted a 9× outlier       │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ALL TOPICS (table: topic · verdict · bet · demand · momentum · room · fit · confidence · age) │
└ 14/16 sources · swept 13m ago · next in 47m · YouTube quota 9,412 left ───────────────────────┘
```

At 390px: the five bets as cards, the scope below them at full width with labels for the top 6 only, the table as a
list, the status rail collapsed to one chip.

### The Dossier (one topic)

```
┌ DOSSIER · APPLE MACBOOK NEO ─────────────────────────────── Research it · Watch · Make a post ⋯ ┐
│ [Bet 82]  Go now · high confidence · US                                                       │
│ Lots of people look for it, it's picking up, the top results are big channels, right in your  │
│ lane.  →  Make a Short in the next 48 hours: 2.5× your usual (1.4–3.8×), 64% to beat it.      │
├──────────────┬──────────────┬──────────────┬──────────────────────────────────────────────────┤
│ Demand 71    │ Momentum 88  │ Room 34      │ Fit 76       (each card: 4–6 evidence rows)      │
├──────────────┴──────────────┴──────────────┴──────────────────────────────────────────────────┤
│ TIMELINE 30d ▁▁▂▂▃▅▇█  news ─ wikipedia ─ our reads    · peaks every September (3 years)     │
├────────────────────────────────────────────┬──────────────────────────────────────────────────┤
│ HOW TO WIN IT                              │ WHO OWNS IT                                      │
│ The angle: the gap in the top 10           │ Top 10: 7 big channels, 0 under a month old      │
│ Titles (scored) · Hook lines · Thumbnail   │ Outliers: 2 videos at 9× and 6× their channel    │
│ brief · Hashtags · Tags · Best time        │ Rivals on it: @varun (2 hits)                    │
├────────────────────────────────────────────┴──────────────────────────────────────────────────┤
│ SEARCHES AROUND IT   long tail · questions · "vs" pairs · Amazon and TikTok suggestions       │
│ LINKS               (the graph: rivals, videos, searches, your posts)                          │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The Sweep's detail panel and the Keyword page merge into this one page. A sweep topic opens its Dossier with the sweep
evidence already filled; the deep reads (long tail, ranking) fill in behind it.

## 4. Data: free sources, checked from a server on 2026-10-29

Radar reads 20+ free sources today (`lib/radar-sources.ts`). Each of these was called from a cloud server this round;
they need one more check from Vercel's network before they ship, because some sites treat cloud IPs differently.

| Source | Answered | What it adds | Notes |
| --- | --- | --- | --- |
| Bluesky search (`api.bsky.app/xrpc/app.bsky.feed.searchPosts`) | 200 | Social chatter per keyword, likes and reposts | The code says Bluesky refuses servers without a key: not any more. `public.api.bsky.app` is reported to 403 on search, so use `api.bsky.app`. One page only (a cursor is refused without a login) |
| Bluesky trending topics (`app.bsky.unspecced.getTrendingTopics`) | 200 | What's trending on Bluesky now | Unspecced: may change, fails on its own |
| TikTok search suggestions (`tiktok.com/api/search/general/preview`) | 200 | What people type on TikTok | No official trends API; Creative Center has none and is login-gated. Suggestions only |
| Amazon autocomplete (`completion.amazon.com/api/2017/suggestions`) | 200 | Buying intent ("macbook neo case") | Good for review and unboxing topics |
| YouTube channel RSS (`youtube.com/feeds/videos.xml?channel_id=`) | 200 | Every rival's latest 15 uploads, no quota | The base of rival tracking and outliers |
| GDELT DOC 2.0 timeline (`api.gdeltproject.org/api/v2/doc/doc?mode=timelinevol`) | 200 | Worldwide news volume over a year | One call per 5 seconds: queue it, cache a day |
| Polymarket events (`gamma-api.polymarket.com/events?order=volume24hr`) | 200 | What the world is betting on (launches, elections, sport) | Public reads, no key. Responses are large: ask for few fields |
| Product Hunt feed (`producthunt.com/feed`) | 200 | New tools launching today | Strong for a tech lane |
| Lemmy (`lemmy.world/api/v3/post/list?sort=Hot`) | 200 | A Reddit-like front page that's open | Smaller than Reddit, but answers |
| Hacker News (Firebase `topstories`) | 200 | The live front page | Algolia search is already in |
| arXiv (`export.arxiv.org/api/query`) | 200 | Papers on AI topics before YouTube has them | A tech-lane early signal |
| iTunes podcast search (`itunes.apple.com/search?media=podcast`) | 200 | How many podcasts already cover it | Competition for the Podcast space |
| Google News and Trends RSS per country | 200 | Already in; extend to every country in the lane | |
| Reddit | 403 | — | Still refuses servers without a paid key |
| Pinterest search and trends | 403 / review | — | The trends API needs app review; revisit then |
| Instagram hashtag pages | login | — | No free read; hashtags come from YouTube, Bluesky and Mastodon |
| Wikidata, OpenAlex | 429 here | — | Rate-limited from shared IPs; optional |

**Our own history is the moat.** The paid tools sell history. We start keeping it: every watched topic and every
topic that reaches the Brief is snapshotted daily (bet, its parts, the raw counts) in R2. After 30 days we have
our own trend lines; after a year, seasonality. Wikipedia pageviews (back to 2015) and GDELT (a year) fill the past on
day one.

## 5. Features, in the order they pay off

Each line: what it is · which paid tool it replaces · how we do it for free · its MCP tool.

### R1. Clarity (the redesign, no new data)
- [ ] One **Bet** score and verdict everywhere; Competition becomes **Room** (higher is better); percentile calibration
      against the reference set so 100 is rare (`lib/radar.ts`).
- [ ] **Brief / Dossier / Watch** replace Sweep / Keyword / Watchlist; Explore lives under the Brief.
- [ ] Command bar with type-ahead; status rail; one action bar per object; evidence rows that wrap.
- [ ] The lane from **phrases**, not single words: two- and three-word phrases from your hits' titles, stop-words out,
      edited in the same dialog.
- [ ] Plain words for every id and code on screen; a legend under the scope readout.

### R2. History and the new sources
- [ ] Daily snapshots of watched and briefed topics; the **timeline** in each Dossier.
- [ ] Bluesky search and trending, TikTok and Amazon suggestions, GDELT timeline, Polymarket, Product Hunt, Lemmy,
      arXiv, iTunes podcasts, YouTube channel RSS (section 4). Each behind the existing `Track` so it fails alone.
- [ ] **Trend stage** for every topic: Emerging, Rising, Peaking, Cooling, Evergreen, from the slope of our snapshots,
      Wikipedia and GDELT (Exploding Topics' stages, from free data).
- [ ] **Seasonality**: "peaks every September" from 3+ years of Wikipedia pageviews; the Brief warns two weeks before a
      known peak.

### R3. Win the topic
- [ ] **Outlier finder** (1of10, ViewStats): every video in a topic's top results and every rival upload scored against
      its own channel's median of the last 20 uploads (channel RSS + `videos.list`, 1 quota unit for 50). Outliers at
      3×+ get a badge and a "why it worked" (title pattern, length, age, format).
- [ ] **Rival tracker**: add any channel (not only pinned rivals); new uploads via RSS every hour, an alert when one
      runs 3× their usual in its first 48 hours; their cadence and best formats.
- [ ] **Content gap** (vidIQ's "low competition", done properly): searches and questions around a topic where the top
      results are old, small channels, or off-angle. The Dossier's "How to win it" names the gap and the promise.
- [ ] **Thumbnail patterns**: the top results' thumbnails read on the CPU (faces, text area, dominant colours,
      brightness), compared with your hits; feeds the thumbnail brief in the Writing room.
- [ ] **"vs" and question maps**: "x vs y" pairs and how/why/what questions from four autocompletes and Stack Overflow,
      grouped by intent.

### R4. Don't miss it
- [ ] **Alerts**: a topic on the watchlist spikes (its count today against its own 14-day baseline, a z-score, not a
      fixed threshold), a rival posts an outlier, a seasonal peak is two weeks out. Through the existing notifications
      (push, email) and the Cloudflare timer that already runs the live feed.
- [ ] **The morning Brief** as a notification and an MCP tool: five bets, what changed, one line each.
- [ ] **Watcher feeds** (from ROADMAP → Next up): your own sources and keywords on a cadence; allow-listed hosts only.

### R5. From idea to post
- [ ] **Make a post** from any Dossier: a post with the topic, the best title, an outline of beats from the gap and the
      questions, the package (`lib/postpack.ts`), the prediction saved to it, and its target (Short / Reel / Video) from
      the format that predicts best.
- [ ] **Calibration chart** on Track: predicted against actual for every judged post, so the owner can see the
      predictions getting better.
- [ ] **Compare** two to four topics side by side (the MCP `keyword_research` compare, on screen).

### R6. For every creator
- [ ] **Profiles, not one lane**: a lane per creator (their channels, their rivals, their countries), so two people in
      the studio see their own Brief.
- [ ] **Bring your own channel** for anyone invited: their YouTube and Instagram connected the same way ours are.
- [ ] **Opening it beyond the studio** is a separate decision with its own work, and isn't on until the owner says so:
      the dashboard is invite-only by design (`lib/access.ts`). It would need sign-up, per-user rate limits and quotas,
      a shared cache so a hundred users don't read the same source a hundred times, and a read of each source's terms
      for commercial use. Until then, more people get Radar by being invited.

### MCP (every step)
Each feature lands with its tool, so Claude can do it too: `radar_brief`, `topic_dossier`, `outliers`, `rivals`
(add, list, alerts), `content_gaps`, `trend_history`, `alerts` (read, set), and the existing `radar`,
`keyword_research`, `seo_score` and `radar_watch` moved onto the one Bet score.

## 6. Rules for every Radar change

- **Free and public sources only**, no keys we'd have to pay for. Each source has a time limit, fails alone, and the
  page says which ones answered.
- **Polite**: cache every read (a sweep for 30 min, a keyword for 6 h, history for a day), respect each source's rate
  limit (GDELT one call per 5 s), name the client where asked (Wikimedia).
- **Only allow-listed hosts** are fetched, never an address a user typed straight through (no internal addresses).
- **Never invent a number.** No filler digits in the telemetry; a missing source shows as missing.
- **Every number explains itself**, and the same topic has the same score everywhere.
- **Measure before and after**: each step is checked on the owner's real lane for how many Brief topics they'd actually
  make (the hit rate) and, once posts go out, on the track record.
- Dark only, 390px checked, `docs/DESIGN.md` and `docs/FEEDBACK.md` win over this file where they disagree.

## Research notes

- Outlier scores are what separates 1of10 and ViewStats from vidIQ and TubeBuddy, which focus on optimisation
  (keywords, SEO scores, A/B tests). ViewStats compares a video with its channel's recent uploads (the free tier uses
  the last 9); 1of10 shows the score on YouTube's own pages. Both are paid for cross-niche search.
  ([OutlierKit: vidIQ vs ViewStats](https://outlierkit.com/resources/vidiq-vs-viewstats/),
  [1of10: vidIQ vs TubeBuddy](https://1of10.com/blog/vidiq-vs-tubebuddy/); both are vendors, read with care.)
- A content gap is "a proven viewer need that existing videos do not satisfy well enough": find demand, diagnose the
  weakness in the current results, make a stronger promise
  ([content gap guide](https://www.overseeros.com/blog/best-youtube-content-gap-finder-tools)).
- Glimpse is built on Google Trends; the paid trend tools mostly add history and curation
  ([Glimpse on Google Trends alternatives](https://meetglimpse.com/google-trends/alternatives/)). Week-over-week growth
  is the early signal ([Trends MCP](https://trendsmcp.ai/blog/best-google-trends-alternatives-2026)).
- YouTube Data API: 10,000 units a day; `search.list` costs 100, `videos.list` 1 for up to 50 videos, so we read search
  pages and RSS and spend quota only on `videos.list` and `channels.list`
  ([Google: quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)).
- TikTok has no official trending-hashtag API; Creative Center is a dashboard and the scrapers are paid and unofficial
  ([Apify listing](https://apify.com/automation-lab/tiktok-trends-scraper)). Pinterest's trends endpoint needs app
  review ([Pinterest docs](https://developers.pinterest.com/docs/analytics-and-reports/trends/)).
- GDELT's DOC 2.0 API is open, its timeline modes reach a year back
  ([GDELT](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)); Polymarket's Gamma API needs no key for reads
  ([Polymarket docs](https://docs.polymarket.com/market-data/overview)); Bluesky's `searchPosts`
  ([Bluesky docs](https://docs.bsky.app/docs/api/app-bsky-feed-search-posts)).
- Palantir's patterns worth taking: an object explorer that filters a whole set with visual tools, then opens one
  object; timelines you can scrub; objects linked into a graph
  ([Palantir: Workshop visualisation widgets](https://palantir.com/docs/foundry/workshop/widgets-visualization/),
  [Vertex time series](https://palantir.com/docs/foundry/vertex/explore-time-series/)).
