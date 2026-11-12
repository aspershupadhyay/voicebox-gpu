// Public by design: the privacy policy Meta asks for before the Instagram app can be published. No data, no sign-in.
import type { Metadata } from "next";
import { ACCOUNTS, LegalPage } from "@/components/legal/Legal";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function Page() {
  return (
    <LegalPage title="Privacy Policy">
      <p>Voicebox Studio is the private studio the creators behind {ACCOUNTS.join(" and ")} use to publish their videos and answer their Instagram audience. It isn&apos;t offered to the public. This page explains what Instagram data it handles and why.</p>

      <h2>What we receive</h2>
      <p>When you comment on one of our posts, send us a direct message, reply to our story, mention us in your story or open one of our ig.me links, Instagram sends us that event through its official API. It contains your Instagram username or user ID, what you wrote, which post it was on and when. When you message us first, Instagram may also share your public name and profile picture.</p>

      <h2>Why we use it</h2>
      <ul>
        <li>To send you what you asked for, for example the link from a Reel after you comment a keyword.</li>
        <li>To answer your messages ourselves, and to keep the conversation in one inbox.</li>
        <li>To count, in total, how many people asked for and opened each link, so we know what our audience finds useful.</li>
        <li>If you send us your email address in a message, to send you what you signed up for.</li>
      </ul>
      <p>We never sell your data, never use it for advertising, and never share it with anyone except the services that run the studio (below).</p>

      <h2>Where it&apos;s kept</h2>
      <p>On Cloudflare (the app and its file storage) and Neon (the database), both under our own accounts. Access is limited to the two creators who run these accounts.</p>

      <h2>How long</h2>
      <p>Conversations and comment history are kept while they&apos;re useful for answering you, and at most 12 months. Emails you send us are kept until you ask us to remove them.</p>

      <h2>Your choices</h2>
      <p>You can ask us to delete everything we hold about you at any time: see <a href="/data-deletion">Data deletion</a>. You can also stop all messages from us by blocking or restricting the account on Instagram.</p>

      <h2>Contact</h2>
      <p>Send a direct message to {ACCOUNTS.join(" or ")} on Instagram.</p>
    </LegalPage>
  );
}
