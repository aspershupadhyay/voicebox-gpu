"use client";
import { useEffect, useRef } from "react";

/** Releases blob: URLs (URL.createObjectURL) once they're no longer in urls, and all of them when the component goes
 *  away. A recording or a dropped file otherwise stays in memory until the tab closes. Other URLs are left alone. */
export function useReleaseBlobs(urls: string[]) {
  const held = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(urls.filter((u) => u.startsWith("blob:")));
    for (const u of held.current) if (!now.has(u)) URL.revokeObjectURL(u);
    held.current = now;
  }, [urls]);
  useEffect(() => () => held.current.forEach((u) => URL.revokeObjectURL(u)), []);
}
