import type { Metadata } from "next";
import { githubEnabled, githubHref, safeNext } from "@/lib/github";
import LoginForm from "./form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return <LoginForm next={next} github={githubEnabled() ? githubHref(next) : undefined} />;
}
