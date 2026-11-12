// Public by design: the terms of service Meta asks for. No data, no sign-in.
import type { Metadata } from "next";
import { ACCOUNTS, LegalPage } from "@/components/legal/Legal";

export const metadata: Metadata = { title: "Terms of Service" };

export default function Page() {
  return (
    <LegalPage title="Terms of Service">
      <p>Voicebox Studio is a private tool used only by the creators of {ACCOUNTS.join(" and ")} to publish their own content and reply to their own audience on Instagram. No one else can sign up or use it.</p>
      <h2>Automatic replies</h2>
      <p>When you comment a keyword, message us or open one of our links, you may get an automatic direct message with what you asked for. We send at most a few messages a day to any one person, only within Instagram&apos;s rules, and a person can always take over the conversation. Reply &ldquo;stop&rdquo; or block the account and you won&apos;t hear from us again.</p>
      <h2>Links we send</h2>
      <p>Links in our messages point to the tools, articles and videos we talk about. They go through a short link of ours so we can count opens. We aren&apos;t responsible for what third-party sites do.</p>
      <h2>Your data</h2>
      <p>How we handle it is in the <a href="/privacy">Privacy Policy</a>, and you can have it deleted any time: <a href="/data-deletion">Data deletion</a>.</p>
      <h2>Changes</h2>
      <p>If these terms change, the date at the top changes with them.</p>
    </LegalPage>
  );
}
