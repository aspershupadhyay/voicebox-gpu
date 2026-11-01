-- Auto-DM round 3 (lib/publish/dmstore.ts creates these by itself on first use; safe to run by hand too):
-- link clicks, A/B variants, what each row waits on (a follow tap or an email), the messaging id Instagram answered
-- with, what was sent, and the emails people DM.
ALTER TABLE autodm_events
  ADD COLUMN IF NOT EXISTS psid text,          -- their id in messages (a commenter's id there differs from comments)
  ADD COLUMN IF NOT EXISTS variant text,       -- a | b (A/B test)
  ADD COLUMN IF NOT EXISTS awaiting text,      -- follow | email
  ADD COLUMN IF NOT EXISTS reply text,         -- what was sent
  ADD COLUMN IF NOT EXISTS links text[],       -- where each tracked link goes (/l/<token> redirects here)
  ADD COLUMN IF NOT EXISTS clicks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
-- kind also: mention (a story mention), ai (an AI answer), mod (a comment rule acted)
-- status also: held (the hourly limit), hidden | deleted | flagged | dismissed (comment rules)
CREATE INDEX IF NOT EXISTS autodm_events_psid ON autodm_events (account, psid, id DESC);
CREATE INDEX IF NOT EXISTS autodm_events_waiting ON autodm_events (status) WHERE status IN ('held', 'gated');

CREATE TABLE IF NOT EXISTS autodm_leads (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  account         text NOT NULL,
  from_id         text NOT NULL,
  from_name       text,
  email           text NOT NULL,
  automation      text,
  automation_name text,
  event           bigint,
  UNIQUE (account, from_id, email)
);
CREATE INDEX IF NOT EXISTS autodm_leads_at ON autodm_leads (at DESC);
