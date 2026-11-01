-- Auto-DM's history (lib/publish/dmstore.ts): one row per comment, DM, story reply or button tap that an automation
-- answered (or skipped, or failed on). The unique key is what makes each comment answered at most once, the rows give
-- the Activity and Contacts tabs and each automation's numbers. The app creates this by itself on first use (the same
-- statements, IF NOT EXISTS); running it by hand is safe too: psql "$DATABASE_URL" -f db/003_autodm.sql

CREATE TABLE IF NOT EXISTS autodm_events (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  account         text NOT NULL,
  kind            text NOT NULL,             -- comment | dm | story
  ref             text NOT NULL,             -- the comment id or message id
  automation      text,
  automation_name text,
  media           text,                      -- the Instagram post or reel commented on
  from_id         text,
  from_name       text,
  text            text,
  status          text NOT NULL,             -- pending | sent | gated | failed | skipped
  replied         boolean NOT NULL DEFAULT false,
  following       boolean,
  error           text,
  note            text,
  UNIQUE (account, kind, ref)
);
CREATE INDEX IF NOT EXISTS autodm_events_at ON autodm_events (at DESC);
CREATE INDEX IF NOT EXISTS autodm_events_automation ON autodm_events (automation, at DESC);
CREATE INDEX IF NOT EXISTS autodm_events_person ON autodm_events (account, from_id);
