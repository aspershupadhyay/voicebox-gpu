# Rewind: posting kit

A 40-second brand film for Prompt Motion (https://prompt-motion.com), made by CatchTheError.
Featured prompt: "Claude motion designer showreel" by @stephanlivera, https://prompt-motion.com/stephanlivera-df17a2

Every link in this kit goes to that one page: the video, the exact prompt, Opus 5.5 · Max, and the Customize button.

## Reel caption

```
You only see the result. Rewind it, and there's the prompt.

This one is a single sentence by @stephanlivera:
"make a dynamic 15-second motion graphics video that shows what an incredible motion designer you are, like it's your showreel for a résumé. go all out."
Made with Claude Opus 5.5.

Prompt Motion (curated by @p4nthera_) collects motion videos made with Claude, with the prompts and skills behind them. Open a video, copy its prompt, or customize it for your own project.

💬 Want the prompt? Comment CATCH and we'll DM you the link.

Our film: every frame drawn in code, the real site rebuilt as moving layers, original score composed in code.

#motiondesign #motiongraphics #claudeai #aivideo #kinetictypography #uidesign #promptengineering
```

## Pinned comment

```
Comment CATCH 👇 and we'll DM you the link to this exact prompt (and the button to customize it for your own video).
```

Instagram's API can post this comment but cannot pin it: pin it by hand in the app (long-press the comment → Pin).

## The DM (sent to everyone who comments CATCH)

```
Hey! Here's the prompt from our Rewind film 🎬

"Claude motion designer showreel" by @stephanlivera on Prompt Motion: the video, the exact prompt (Opus 5.5, effort Max) and a Customize button to make it yours.

👉 https://prompt-motion.com/stephanlivera-df17a2

Make something with it? Tag us, we'd love to see it.
```

Button label (if the tool supports a button): `Open the prompt`

Public reply under the comment (optional, keeps the thread alive): `Sent! Check your DMs 📩`

## Story

`story.mp4` (1080×1920, 10 s). Upload it as a Story and add, in the Instagram app:
- a **Link sticker** to https://prompt-motion.com/stephanlivera-df17a2 (label: "Get the prompt"), placed in the empty space
  below the end card (y ≈ 1600). The API can't add link stickers; the app can.
- optionally a **Mention sticker** for @p4nthera_ and @stephanlivera.

## The CATCH → DM automation: status and setup

**Update (2026-11-01): built into VoiceBox** (Posts → Auto-DM; setup in `docs/PUBLISHING.md` → Auto-DM). Add one rule:
keyword `CATCH`, the Rewind Reel (or every post), the DM below with the button "Open the prompt", public answer
`Sent! Check your DMs 📩`, DMs and story replies on. It starts sending once the Meta messaging permission, the webhook and
the reconnect are done. ManyChat (Option A below) stays the fallback if App Review takes too long.

**Status: not active.** I checked and haven't pretended otherwise:
- VoiceBox's Instagram connection (@catchtheerror) has the scopes `instagram_business_basic`, `content_publish`,
  `manage_comments` and `manage_insights`. Sending a DM needs `instagram_business_manage_messages`, which it doesn't
  have.
- VoiceBox has no webhook that hears new comments, so nothing could trigger a DM anyway.
- So the Reel is saved as a **draft, not scheduled**: posting "Comment CATCH" before the DM works would leave people
  waiting.

### Option A: ManyChat (an official Meta Business Partner), about 10 minutes, no code

1. Go to manychat.com → sign up with Facebook/Instagram → connect **@catchtheerror** (it must be a Professional
   account: it is, a Creator account). Allow the messaging permissions it asks for.
2. In Instagram on your phone: Settings → Messages and story replies → Message controls → **Connected tools → Allow
   access to messages: ON**.
3. ManyChat → Automation → **New automation → "Auto-DM links from comments"** (the Comment template).
4. Trigger: **User comments on your Post or Reel** → choose "Specific post or reel" (pick Rewind once it's live; until
   then "Next post or reel"). Keywords: `CATCH` (ManyChat's keyword match is case-insensitive, so "catch" and "Catch"
   work).
5. Turn on **Reply to their comment publicly** with `Sent! Check your DMs 📩`.
6. Message: paste the DM above. Add a button "Open the prompt" → https://prompt-motion.com/stephanlivera-df17a2.
7. Optional, same automation: add the trigger **User replies to your Story** with keyword `CATCH`, so Story viewers get it
   too.
8. Set it Live.
9. **Test before publishing:** publish the Reel, then from a *different* Instagram account comment `catch`. Within a few
   seconds that account should get the DM, and your public reply should appear. Then comment `CATCH!` and
   `I want it catch` to check the keyword match. If no DM arrives, the usual cause is step 2.

Instagram's own limits: an automatic reply to a comment is one message per comment and must go out within 7 days of
the comment; after the person replies, the conversation is open for 24 hours.

### Option B: build it into VoiceBox (later, if you want it in-house)

Needs four things from the owner, so I haven't built it:
1. In the Meta app (INSTAGRAM_APP_ID): add the `instagram_business_manage_messages` permission, and for people who
   aren't app testers, pass **App Review** for it (Advanced Access).
2. Reconnect @catchtheerror in Posts → Autopilot so the new permission is granted.
3. Add a webhook route (Meta calls it on new comments). It has to be public, verified by Meta's signature
   (X-Hub-Signature-256 with the app secret), like the other public-by-design routes in CLAUDE.md. That's a new
   public route, so it's the owner's call.
4. Subscribe the app to the `comments` field. The handler: if the comment is on the Rewind Reel and contains
   `catch` (any case), call `POST /{ig-user-id}/messages` with `recipient: {comment_id}` and the DM text above (a
   "private reply").
