"use client";
// Documents in the file viewer, read in the browser (nothing goes to another service): PDF pages drawn by PDF.js as you
// scroll to them, Word files laid out as pages (docx-preview), spreadsheets and CSV as a grid with sheet tabs (SheetJS),
// and text, Markdown, JSON, subtitles and code with line numbers. Each loads its library only when it's needed.
import { ArrowsInLineHorizontal, Copy, MagnifyingGlassMinus, MagnifyingGlassPlus, TextAlignLeft, WarningCircle } from "@phosphor-icons/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

export type DocKind = "pdf" | "docx" | "sheet" | "text" | "pptx" | "none";

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const TEXT_EXT = new Set(["txt", "md", "markdown", "json", "srt", "vtt", "csv", "tsv", "log", "xml", "yaml", "yml", "toml", "ini", "env", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cs", "php", "sh", "sql", "lrc", "ass", "rtf"]);
const SHEET_EXT = new Set(["xlsx", "xlsm", "xls", "ods", "csv", "tsv", "numbers"]);

/** Which viewer a file gets, from its name and type. */
export function docKind(name: string, mime?: string | null): DocKind {
  const e = ext(name), m = mime ?? "";
  if (e === "pdf" || m === "application/pdf") return "pdf";
  if (e === "docx" || m.includes("wordprocessingml")) return "docx";
  if (SHEET_EXT.has(e) || m.includes("spreadsheet") || m === "text/csv" || m.includes("ms-excel")) return "sheet";
  if (e === "pptx" || m.includes("presentationml")) return "pptx";
  if (TEXT_EXT.has(e) || m.startsWith("text/") || m === "application/json" || m.includes("xml")) return "text";
  return "none";
}

function Problem({ text }: { text: string }) {
  return <div className="dv-problem"><WarningCircle size={28} weight="duotone" /><p>{text}</p></div>;
}
const Loading = () => <div className="dv-loading"><span className="vp-spin" /></div>;

async function bytes(url: string, max: number) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`couldn't load the file (${r.status})`);
  const n = Number(r.headers.get("content-length") || 0);
  if (n > max) throw new Error(`too big to preview (${(n / 1e6).toFixed(0)} MB): download it instead`);
  return r.arrayBuffer();
}

// ── PDF

export function PdfView({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [cur, setCur] = useState(1);
  const docRef = useRef<{ getPage: (n: number) => Promise<unknown>; destroy: () => void } | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const task = pdfjs.getDocument({ url });
        const doc = await task.promise;
        if (dead) { task.destroy(); return; }
        docRef.current = { getPage: (n) => doc.getPage(n), destroy: () => { task.destroy(); } };
        setPages(doc.numPages);
      } catch (e) {
        if (!dead) setErr((e as Error).message || "This PDF can't be shown");
      }
    })();
    return () => { dead = true; docRef.current?.destroy(); docRef.current = null; };
  }, [url]);

  // draw each page when it comes near the screen, at the screen's sharpness
  useEffect(() => {
    const box = host.current;
    if (!box || !pages) return;
    const drawn = new Map<number, number>();
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        const n = Number((en.target as HTMLElement).dataset.page);
        if (!en.isIntersecting || drawn.get(n) === zoom) continue;
        drawn.set(n, zoom);
        (async () => {
          type Page = { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: object) => { promise: Promise<void> } };
          const page = (await docRef.current?.getPage(n)) as Page | undefined;
          if (!page) return;
          const holder = en.target as HTMLElement;
          const base = page.getViewport({ scale: 1 });
          const width = Math.min(box.clientWidth - 24, 980) * zoom;
          const scale = width / base.width;
          const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
          const c = document.createElement("canvas");
          c.width = vp.width; c.height = vp.height;
          c.style.width = `${width}px`; c.style.height = `${(base.height * scale)}px`;
          await page.render({ canvas: c, viewport: vp }).promise;
          holder.replaceChildren(c);
          holder.style.width = c.style.width; holder.style.height = c.style.height;
        })().catch(() => null);
      }
    }, { root: box, rootMargin: "600px 0px" });
    box.querySelectorAll<HTMLElement>(".pdf-page").forEach((p) => io.observe(p));
    // the page counter: the page crossing the middle of the view
    const onScroll = () => {
      const mid = box.getBoundingClientRect().top + box.clientHeight / 2;
      for (const p of box.querySelectorAll<HTMLElement>(".pdf-page")) { const r = p.getBoundingClientRect(); if (r.bottom >= mid) { setCur(Number(p.dataset.page)); break; } }
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => { io.disconnect(); box.removeEventListener("scroll", onScroll); };
  }, [pages, zoom]);

  if (err) return <Problem text={err} />;
  if (!pages) return <Loading />;
  const w = Math.min((host.current?.clientWidth ?? 800) - 24, 980) * zoom;
  return (
    <div className="dv dv-pdf">
      <div className="dv-tools">
        <span className="mono small">{cur} / {pages}</span>
        <span className="grow" />
        <button className="vp-btn" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out"><MagnifyingGlassMinus size={18} /></button>
        <span className="mono small">{Math.round(zoom * 100)}%</span>
        <button className="vp-btn" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} aria-label="Zoom in"><MagnifyingGlassPlus size={18} /></button>
        <button className="vp-btn" onClick={() => setZoom(1)} aria-label="Fit width"><ArrowsInLineHorizontal size={18} /></button>
      </div>
      <div className="dv-scroll" ref={host} tabIndex={0} aria-label="PDF pages">
        {Array.from({ length: pages }, (_, i) => <div key={`${i}-${zoom}`} className="pdf-page" data-page={i + 1} style={{ width: w, height: w * 1.294 }} role="img" aria-label={`Page ${i + 1}`} />)}
      </div>
    </div>
  );
}

// ── Word

export function DocxView({ url }: { url: string }) {
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [{ renderAsync }, buf] = await Promise.all([import("docx-preview"), bytes(url, 60e6)]);
        if (dead || !body.current) return;
        await renderAsync(buf, body.current, styles.current ?? undefined, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: true, useBase64URL: true });
        if (!dead) setReady(true);
      } catch (e) {
        if (!dead) setErr((e as Error).message || "This document can't be shown");
      }
    })();
    return () => { dead = true; };
  }, [url]);
  // pages keep their real size and are zoomed to fit a narrow screen, the way a phone shows a document
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready || !scroller.current || !body.current) return;
    const fit = () => {
      const page = body.current?.querySelector<HTMLElement>("section.docx");
      if (!page || !body.current || !scroller.current) return;
      body.current.style.zoom = "1";
      const z = Math.min(1, (scroller.current.clientWidth - 16) / (page.offsetWidth + 24));
      body.current.style.zoom = String(Math.max(0.3, z));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(scroller.current);
    return () => ro.disconnect();
  }, [ready]);
  if (err) return <Problem text={err} />;
  return (
    <div className="dv dv-docx">
      {!ready && <Loading />}
      <div ref={styles} />
      <div className="dv-scroll" ref={scroller} tabIndex={0} aria-label="Document"><div ref={body} className="docx-host" /></div>
    </div>
  );
}

// ── spreadsheets and CSV

type Sheet = { name: string; rows: string[][]; cut: boolean };
const COLS = (n: number) => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export function SheetView({ url, name }: { url: string; name: string }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [i, setI] = useState(0);
  const [err, setErr] = useState("");
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [XLSX, buf] = await Promise.all([import("xlsx"), bytes(url, 50e6)]);
        const e = ext(name);
        const wb = e === "csv" || e === "tsv" ? XLSX.read(new TextDecoder().decode(buf), { type: "string", FS: e === "tsv" ? "\t" : undefined, raw: true }) : XLSX.read(buf, { type: "array", cellDates: true, dense: true });
        const out = wb.SheetNames.slice(0, 40).map((n) => {
          const all = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: "", blankrows: false });
          const rows = all.slice(0, 2000).map((r) => r.slice(0, 120).map((c) => String(c ?? "")));
          return { name: n, rows, cut: all.length > 2000 || all.some((r) => r.length > 120) };
        });
        if (!dead) setSheets(out);
      } catch (e) {
        if (!dead) setErr((e as Error).message || "This sheet can't be shown");
      }
    })();
    return () => { dead = true; };
  }, [url, name]);
  if (err) return <Problem text={err} />;
  if (!sheets) return <Loading />;
  const sh = sheets[i] ?? sheets[0];
  const width = Math.max(1, ...sh.rows.map((r) => r.length));
  return (
    <div className="dv dv-sheet">
      <div className="dv-scroll" tabIndex={0} aria-label={`Sheet ${sh.name}`}>
        {sh.rows.length ? (
          <table className="sheet">
            <thead><tr><th className="corner"><span className="sr-only">Row</span></th>{Array.from({ length: width }, (_, c) => <th key={c} scope="col">{COLS(c)}</th>)}</tr></thead>
            <tbody>{sh.rows.map((r, ri) => (
              <tr key={ri}><th scope="row">{ri + 1}</th>{Array.from({ length: width }, (_, c) => <td key={c} className={/^-?[\d.,%$€£₹]+$/.test(r[c] ?? "") ? "n" : undefined}>{r[c] ?? ""}</td>)}</tr>
            ))}</tbody>
          </table>
        ) : <Problem text="This sheet is empty." />}
      </div>
      <div className="sheet-tabs" role="tablist" aria-label="Sheets">
        {sheets.map((s, k) => <button key={s.name} role="tab" aria-selected={k === i} className={k === i ? "on" : ""} onClick={() => setI(k)}>{s.name}</button>)}
        {sh.cut && <span className="tiny faint">Showing the first 2,000 rows and 120 columns</span>}
      </div>
    </div>
  );
}

// ── text, Markdown, JSON, subtitles, code

function Markdown({ text }: { text: string }) {
  const inline = (s: string, k: string) => s.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g).map((p, i) => {
    if (/^\*\*.+\*\*$/.test(p)) return <b key={k + i}>{p.slice(2, -2)}</b>;
    if (/^\*.+\*$/.test(p)) return <em key={k + i}>{p.slice(1, -1)}</em>;
    if (/^`.+`$/.test(p)) return <code key={k + i}>{p.slice(1, -1)}</code>;
    const l = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (l && /^https?:\/\//.test(l[2])) return <a key={k + i} href={l[2]} target="_blank" rel="noreferrer">{l[1]}</a>;
    return <Fragment key={k + i}>{p}</Fragment>;
  });
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(<pre key={i}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const h = ln.match(/^(#{1,6})\s+(.*)/);
    if (h) { const H = `h${Math.min(6, h[1].length + 1)}` as "h2"; out.push(<H key={i}>{inline(h[2], `h${i}`)}</H>); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      i--;
      out.push(<ul key={i}>{items.map((t, k) => <li key={k}>{inline(t, `l${i}-${k}`)}</li>)}</ul>);
      continue;
    }
    if (/^>\s?/.test(ln)) { out.push(<blockquote key={i}>{inline(ln.replace(/^>\s?/, ""), `q${i}`)}</blockquote>); continue; }
    if (/^(-{3,}|\*{3,})$/.test(ln.trim())) { out.push(<hr key={i} />); continue; }
    if (ln.trim()) out.push(<p key={i}>{inline(ln, `p${i}`)}</p>);
  }
  return <article className="md">{out}</article>;
}

export function TextView({ url, name }: { url: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const [err, setErr] = useState("");
  const [wrap, setWrap] = useState(true);
  const e = ext(name);
  const [source, setSource] = useState(!(e === "md" || e === "markdown"));
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`couldn't load the file (${r.status})`);
        const buf = new Uint8Array(await r.arrayBuffer());
        const max = 3_000_000;
        let t = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, max));
        if (e === "json") { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* show it as it is */ } }
        if (!dead) { setText(t); setCut(buf.length > max); }
      } catch (er) {
        if (!dead) setErr((er as Error).message);
      }
    })();
    return () => { dead = true; };
  }, [url, e]);
  const lines = useMemo(() => (text ?? "").split("\n"), [text]);
  if (err) return <Problem text={err} />;
  if (text === null) return <Loading />;
  return (
    <div className="dv dv-text">
      <div className="dv-tools">
        <span className="small dim">{lines.length.toLocaleString()} lines{cut ? " · first 3 MB" : ""}</span>
        <span className="grow" />
        {(e === "md" || e === "markdown") && <button className="vp-btn txt" onClick={() => setSource((x) => !x)}>{source ? "Preview" : "Source"}</button>}
        <button className={`vp-btn ${wrap ? "on" : ""}`} onClick={() => setWrap((w) => !w)} aria-pressed={wrap} aria-label="Wrap lines" title="Wrap lines"><TextAlignLeft size={18} /></button>
        <button className="vp-btn" onClick={() => navigator.clipboard.writeText(text).catch(() => null)} aria-label="Copy all" title="Copy all"><Copy size={18} /></button>
      </div>
      <div className="dv-scroll" tabIndex={0} aria-label={name}>
        {!source ? <Markdown text={text} /> : (
          <pre className={`code ${wrap ? "wrap" : ""}`}>{lines.map((l, i) => <span key={i} className="ln"><i aria-hidden>{i + 1}</i>{l || " "}{"\n"}</span>)}</pre>
        )}
      </div>
    </div>
  );
}
