// A Kaggle Benchmark of our own work (the owner, 2026-11-10: "set up the Kaggle benchmark"): which AI model can tell
// which of two of our own posts did better, from its opening line alone. The pairs come from our analytics (same
// account and format, one did at least twice as well as the other against the account's usual), so the answer key is
// real results, not taste. Kaggle runs it on its models with Kaggle's free model credits ($10 a day, $100 a month,
// for Benchmarks only); the scores tell us which model to trust with hooks, titles and captions.
// The task stays private (never published). Server side only, with the Kaggle key on the Worker (lib/kaggle.ts).
import { kaggleCall, kaggleConfigured } from "./kaggle";

export const TASK = "which-hook-wins";
const TASKS = "benchmarks.BenchmarkTasksApiService";
const ABOUT: Record<string, string> = {
  CatchTheError: "an AI and developer-tools news channel (Instagram Reels and YouTube Shorts)",
  "Elite Minds": "a geopolitics and economics explainer channel (Instagram Reels and YouTube Shorts)",
};

type Pair = { channel: string; a: string; b: string; winner: "A" | "B"; ratio: number };

/** Pairs from the last 90 days: same account and format, scores at least 2× apart. Deterministic, at most `max`. */
export async function buildPairs(max = 60): Promise<Pair[]> {
  const { getAnalytics } = await import("./analytics");
  const a = await getAnalytics(90);
  const names = new Map(a.accounts.map((x) => [x.id, x.name]));
  const items = a.items.filter((i) => i.title && typeof i.score === "number" && i.score > 0 && i.title.trim().length > 12);
  const groups = new Map<string, typeof items>();
  for (const i of items) { const k = `${i.account}|${i.fmt}`; groups.set(k, [...(groups.get(k) ?? []), i]); }
  const pairs: Pair[] = [];
  let flip = 0;
  for (const [k, g] of groups) {
    const sorted = [...g].sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    const channel = names.get(k.split("|")[0]) ?? "our channel";
    // each strong post against the weak ones it clearly beat, best gaps first
    for (let i = 0; i < sorted.length; i++) for (let j = sorted.length - 1; j > i; j--) {
      const hi = sorted[i], lo = sorted[j], ratio = (hi.score ?? 0) / Math.max(0.01, lo.score ?? 0);
      if (ratio < 2) continue;
      const hiFirst = flip++ % 2 === 0; // half the winners are A, half B: no position bias in the key
      pairs.push({ channel, a: (hiFirst ? hi : lo).title!.trim(), b: (hiFirst ? lo : hi).title!.trim(), winner: hiFirst ? "A" : "B", ratio: Math.round(ratio * 10) / 10 });
    }
  }
  // spread across channels and formats: take round-robin from the strongest gaps
  pairs.sort((x, y) => y.ratio - x.ratio);
  const seen = new Set<string>(), out: Pair[] = [];
  for (const p of pairs) { const key = `${p.a}|${p.b}`; if (!seen.has(key)) { seen.add(key); out.push(p); } if (out.length >= max) break; }
  return out;
}

/** The task notebook: one row task (store_task=False) and the scored task over every pair. */
function notebook(pairs: Pair[]) {
  const data = JSON.stringify(pairs.map((p) => ({ channel: `${p.channel}, ${ABOUT[p.channel] ?? "a short-form video channel"}`, a: p.a, b: p.b, winner: p.winner })));
  const cells = [
    `# Which hook wins? Two real posts from the same channel and format; one got at least twice as many views (against the
# channel's usual) as the other. The model sees only each post's opening line and picks the winner. Score: accuracy.
import json, re
import pandas as pd
import kaggle_benchmarks as kbench`,
    `PAIRS = json.loads(${JSON.stringify(data)})
df = pd.DataFrame(PAIRS)
print(len(df), "pairs")`,
    `@kbench.task(name="which-hook-wins-pair", store_task=False)
def pick(llm, channel: str, a: str, b: str, winner: str) -> bool:
    with kbench.chats.new("pair"):
        answer = llm.prompt(
            f"You run {channel}. Two of its short videos opened with these lines. One of them got far more views than "
            f"the channel usually gets; the other did far worse.\\n\\nA: {a}\\n\\nB: {b}\\n\\n"
            "Which one did better? Answer with the single letter A or B."
        )
    m = re.search(r"\\b([AB])\\b", str(answer).strip().upper())
    return bool(m and m.group(1) == winner)`,
    `@kbench.task(name="${TASK}", description="Picks which of two real posts from the same channel did better, from the opening line alone.")
def which_hook_wins(llm, df) -> float:
    runs = pick.evaluate(llm=[llm], evaluation_data=df)
    return float(runs.as_dataframe()["result"].astype(float).mean())`,
    `which_hook_wins.run(kbench.llm, df)`,
    `%choose ${TASK}`,
  ];
  return JSON.stringify({
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
    nbformat: 4, nbformat_minor: 5,
    cells: cells.map((source) => ({ cell_type: "code", metadata: {}, execution_count: null, outputs: [], source })),
  });
}

const slug = () => ({ taskSlug: TASK });
const clean = (s?: string) => String(s ?? "").toLowerCase().replace(/^benchmark_task_(run|version_creation)_state_/, "");

/** Build the pairs from today's analytics and push them as a new version of the task (Kaggle checks it runs). */
export async function pushBenchmark(max?: number) {
  if (!kaggleConfigured()) throw new Error("Kaggle isn't set up: KAGGLE_USERNAME and KAGGLE_API_TOKEN on the Worker.");
  const pairs = await buildPairs(max);
  if (pairs.length < 10) throw new Error(`only ${pairs.length} clear pairs in the last 90 days (10 needed): post more and try again`);
  const r = await kaggleCall<{ url?: string; error?: string }>(TASKS, "CreateBenchmarkTask", { slug: TASK, text: notebook(pairs) });
  if (r.error) throw new Error(`Kaggle refused the task: ${r.error}`);
  const byChannel = pairs.reduce<Record<string, number>>((m, p) => ({ ...m, [p.channel]: (m[p.channel] ?? 0) + 1 }), {});
  return { pushed: true, pairs: pairs.length, by_channel: byChannel, url: r.url ? `https://www.kaggle.com${r.url.startsWith("/") ? r.url : `/${r.url}`}` : null,
    next: "Kaggle checks the task (a few minutes); then run it on models with action run." };
}

/** The models Kaggle can run it on (their slugs, for action run). */
export async function benchmarkModels() {
  const out: { name: string; slug: string }[] = [];
  let token = "";
  for (let i = 0; i < 10; i++) {
    const r = await kaggleCall<{ benchmarkModels?: { displayName?: string; version?: { slug?: string } }[]; nextPageToken?: string }>(
      "benchmarks.BenchmarksApiService", "ListBenchmarkModels", { pageSize: 100, pageToken: token });
    for (const m of r.benchmarkModels ?? []) if (m.version?.slug) out.push({ name: m.displayName ?? m.version.slug, slug: m.version.slug });
    if (!r.nextPageToken) break;
    token = r.nextPageToken;
  }
  return out;
}

/** Run the task on these models (Kaggle's free credits pay for it). */
export async function runBenchmark(models: string[]) {
  const t = await kaggleCall<{ creationState?: string; creationErrorMessage?: string }>(TASKS, "GetBenchmarkTask", { slug: slug() });
  const state = clean(t.creationState);
  if (state !== "completed") throw new Error(`the task isn't ready yet (${state || "unknown"}${t.creationErrorMessage ? `: ${t.creationErrorMessage}` : ""})`);
  const r = await kaggleCall<{ results?: { runScheduled?: boolean; error?: string }[] }>(TASKS, "BatchScheduleBenchmarkTaskRuns", { taskSlugs: [slug()], modelVersionSlugs: models });
  return { scheduled: models.map((m, i) => ({ model: m, ok: !!r.results?.[i]?.runScheduled, ...(r.results?.[i]?.error ? { error: r.results[i].error } : {}) })) };
}

/** The task's state and every model's score so far, best first. */
export async function benchmarkStatus() {
  const t = await kaggleCall<{ creationState?: string; creationErrorMessage?: string; url?: string }>(TASKS, "GetBenchmarkTask", { slug: slug() });
  const runs = await kaggleCall<{ runs?: { modelVersionSlug?: string; state?: string; errorMessage?: string; result?: { numericResult?: number; booleanResult?: boolean }; endTime?: string }[] }>(
    TASKS, "ListBenchmarkTaskRuns", { taskSlug: slug(), pageSize: 100 }).catch(() => ({ runs: [] }));
  const latest = new Map<string, NonNullable<typeof runs.runs>[number]>();
  for (const r of runs.runs ?? []) if (r.modelVersionSlug && !latest.has(r.modelVersionSlug)) latest.set(r.modelVersionSlug, r);
  const scores = [...latest.values()].map((r) => ({ model: r.modelVersionSlug, state: clean(r.state),
    accuracy: typeof r.result?.numericResult === "number" ? Math.round(r.result.numericResult * 1000) / 10 : null, ...(r.errorMessage ? { error: r.errorMessage } : {}) }))
    .sort((x, y) => (y.accuracy ?? -1) - (x.accuracy ?? -1));
  return { task: TASK, state: clean(t.creationState), ...(t.creationErrorMessage ? { error: t.creationErrorMessage } : {}),
    url: t.url ? `https://www.kaggle.com${t.url.startsWith("/") ? t.url : `/${t.url}`}` : null, scores,
    note: "Accuracy is the share of pairs where the model picked the post that really did better: 50% is a coin flip." };
}
