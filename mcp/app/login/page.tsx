import { githubEnabled, githubHref } from "@/lib/github";
import LoginForm from "./form";

export const dynamic = "force-dynamic";

export default function Login() {
  return <LoginForm github={githubEnabled() ? githubHref("/") : undefined} />;
}
