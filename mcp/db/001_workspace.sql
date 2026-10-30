-- The shared workspace in Postgres (Neon), replacing Appwrite's TablesDB "studio" (docs/MIGRATION.md, phase 2).
-- Same four tables and columns as Appwrite; ids are kept as they are, so links, post ids and m:<id> file ids carry over.
-- Run once per branch: psql "$DATABASE_URL" -f db/001_workspace.sql (safe to run again).

CREATE TABLE IF NOT EXISTS posts (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  title         varchar(200) NOT NULL,
  status        text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'draft', 'review', 'scheduled', 'posted')),
  platforms     text[] NOT NULL DEFAULT '{}',
  script        text,
  caption       text,
  notes         text,
  due_at        timestamptz,
  posted_at     timestamptz,
  link          varchar(500),
  owner_id      varchar(36),
  owner_name    varchar(128),
  assignee_id   varchar(36),
  assignee_name varchar(128),
  jobs          text[] NOT NULL DEFAULT '{}',
  cover         varchar(36)
);
CREATE INDEX IF NOT EXISTS posts_by_status ON posts (status);
CREATE INDEX IF NOT EXISTS posts_by_due ON posts (due_at);

CREATE TABLE IF NOT EXISTS comments (
  id          text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  post_id     varchar(36) NOT NULL,
  body        text NOT NULL,
  author_id   varchar(36),
  author_name varchar(128)
);
CREATE INDEX IF NOT EXISTS comments_by_post ON comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS activity (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  post_id    varchar(36),
  verb       varchar(64) NOT NULL,
  text       varchar(500),
  actor_id   varchar(36),
  actor_name varchar(128)
);
CREATE INDEX IF NOT EXISTS activity_by_post ON activity (post_id);
CREATE INDEX IF NOT EXISTS activity_by_time ON activity (created_at DESC);

CREATE TABLE IF NOT EXISTS media (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  file_id       varchar(36) NOT NULL,
  name          varchar(255) NOT NULL,
  mime          varchar(128),
  size          bigint,
  kind          text NOT NULL DEFAULT 'other' CHECK (kind IN ('image', 'video', 'audio', 'doc', 'other')),
  post_id       varchar(36),
  uploaded_by   varchar(36),
  uploaded_name varchar(128),
  r2_key        varchar(512),
  token         varchar(512)
);
CREATE INDEX IF NOT EXISTS media_by_post ON media (post_id);
CREATE INDEX IF NOT EXISTS media_by_kind ON media (kind);
CREATE INDEX IF NOT EXISTS media_by_file ON media (file_id);
CREATE INDEX IF NOT EXISTS media_by_time ON media (created_at DESC);
