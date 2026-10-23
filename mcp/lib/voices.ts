// Your recorded voices and the per-voice audition samples, both kept in R2 so they outlive the Colab runtime.
//   voices/<name>/reference.wav + meta.json   cleaned recording + Whisper transcript (synced to the worker on use)
//   samples/<engine>/<voice>.wav + samples/index.json   one short read per voice, playable without the GPU
import { delPrefix, getJson, listObjs, presign, putJson } from "./store";

export type MyVoice = { name: string; label: string; transcript: string; duration: number; version: string; created: number; warnings?: string[]; level_db?: number; enhanced?: boolean };
export type SampleIndex = { text: Record<string, string>; voices: Record<string, Record<string, { duration: number; created: number }>> };

export const VOICE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const PRESETS = new Set(["female", "male", "default"]);
export const isCustomVoice = (v: string) => VOICE_RE.test(v) && !PRESETS.has(v);

export async function listMyVoices(withUrls = true) {
  const keys = (await listObjs("voices/")).map((o) => o.key).filter((k) => k.endsWith("/meta.json"));
  const all = (await Promise.all(keys.map((k) => getJson<MyVoice>(k).catch(() => null)))).filter(Boolean) as MyVoice[];
  all.sort((a, b) => b.created - a.created);
  return withUrls ? Promise.all(all.map(async (v) => ({ ...v, url: await presign(`voices/${v.name}/reference.wav`) }))) : all;
}

export const getMyVoice = (name: string) => (isCustomVoice(name) ? getJson<MyVoice>(`voices/${name}/meta.json`).catch(() => null) : Promise.resolve(null));
export const putMyVoice = (v: MyVoice) => putJson(`voices/${v.name}/meta.json`, v);
export const deleteMyVoice = (name: string) => delPrefix(`voices/${name}/`);
export const voicePutUrl = (name: string) => presign(`voices/${name}/reference.wav`, "PUT", 15 * 60);

/** What the worker needs to use a recorded voice: a short-lived link to the wav, its transcript, and a version tag. */
export async function refSync(name: string) {
  const v = await getMyVoice(name);
  return v ? { url: await presign(`voices/${name}/reference.wav`, "GET", 3600), transcript: v.transcript, version: v.version } : null;
}

export async function getSamples() {
  const idx = (await getJson<SampleIndex>("samples/index.json").catch(() => null)) ?? { text: {}, voices: {} };
  const voices: Record<string, Record<string, { duration: number; url: string }>> = {};
  await Promise.all(Object.entries(idx.voices).flatMap(([eng, vs]) => Object.entries(vs).map(async ([v, m]) => {
    (voices[eng] ??= {})[v] = { duration: m.duration, url: await presign(`samples/${eng}/${v}.wav`, "GET", 24 * 3600) };
  })));
  return { text: idx.text, voices };
}

export async function recordSample(engine: string, voice: string, duration: number, text: string) {
  const idx = (await getJson<SampleIndex>("samples/index.json").catch(() => null)) ?? { text: {}, voices: {} };
  (idx.voices[engine] ??= {})[voice] = { duration, created: Date.now() };
  idx.text[`${engine}/${voice}`] = text;
  await putJson("samples/index.json", idx);
}

export const samplePutUrl = (engine: string, voice: string) => presign(`samples/${engine}/${voice}.wav`, "PUT", 15 * 60);
