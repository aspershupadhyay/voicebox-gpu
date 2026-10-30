// Who is calling, for code deep below a tool (docs/FACTORY.md E): guarded() runs every tool inside it, and lib/worker.ts
// tags each job it sends with the caller as its owner, so the worker's lanes take turns between callers.
import { AsyncLocalStorage } from "node:async_hooks";

export const caller = new AsyncLocalStorage<{ model: string }>();
