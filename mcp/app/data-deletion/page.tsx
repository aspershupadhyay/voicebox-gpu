// Public by design: the data deletion instructions Meta asks for. A DM saying "delete my data" removes everything
// Auto-DM holds about that person (lib/publish/autodm.ts forgetPerson), and they get a confirmation.
import type { Metadata } from "next";
import { ACCOUNTS, LegalPage } from "@/components/legal/Legal";

export const metadata: Metadata = { title: "Data deletion" };

export default function Page() {
  return (
    <LegalPage title="Delete your data">
      <p>You can have everything Voicebox Studio holds about you deleted, at any time, in one message.</p>
      <ol>
        <li>Open Instagram and send a direct message to {ACCOUNTS.join(" or ")}.</li>
        <li>Write: <b>delete my data</b></li>
        <li>You&apos;ll get a reply confirming it&apos;s done, usually within a minute.</li>
      </ol>
      <p>This removes your messages, the comments of yours we answered, your tags and notes, any email address you sent us, and your name and picture from our records. It can&apos;t be undone. Comments you posted publicly stay on Instagram itself: delete them there.</p>
      <p>If you&apos;ve removed this app from your Instagram settings (Settings → Website permissions → Apps and websites), we also stop receiving anything about you.</p>
    </LegalPage>
  );
}
