"use client";
// In-app replacements for window.confirm / window.alert: a promise-based confirm dialog and toasts.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Ask = { title: string; body?: React.ReactNode; confirm?: string; cancel?: string; danger?: boolean };
type Toast = { id: number; text: string; tone: "ok" | "bad" | "info" };
type Ctx = { confirm: (a: Ask) => Promise<boolean>; toast: (text: string, tone?: Toast["tone"]) => void };

const DialogCtx = createContext<Ctx>({ confirm: async () => false, toast: () => {} });
export const useDialog = () => useContext(DialogCtx);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [ask, setAsk] = useState<(Ask & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  const confirm = useCallback((a: Ask) => new Promise<boolean>((resolve) => setAsk({ ...a, resolve })), []);
  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 7000 : 4000);
  }, []);

  const close = useCallback((v: boolean) => { setAsk((a) => { a?.resolve(v); return null; }); }, []);
  useEffect(() => {
    if (!ask) return;
    (ask.danger ? cancelRef : okRef).current?.focus();  // Enter must never delete by accident
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, close]);

  return (
    <DialogCtx.Provider value={{ confirm, toast }}>
      {children}
      {ask && (
        <>
          <div className="scrim-modal" onClick={() => close(false)} />
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
            {ask.danger && <div className="modal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg></div>}
            <h3 id="dlg-title">{ask.title}</h3>
            {ask.body && <div className="modal-body">{ask.body}</div>}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 22 }}>
              <button ref={cancelRef} className="ghost" onClick={() => close(false)}>{ask.cancel ?? "Cancel"}</button>
              <button ref={okRef} className={ask.danger ? "danger" : "sig"} onClick={() => close(true)}>{ask.confirm ?? "OK"}</button>
            </div>
          </div>
        </>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </DialogCtx.Provider>
  );
}
