-- Sign-in accounts in Postgres, replacing Appwrite's accounts and studio team (docs/MIGRATION.md, 2b; lib/users.ts).
-- ids are kept from Appwrite, so every post, comment and file stays attributed to the same person. A password is an
-- scrypt hash (never the password); an account moved from Appwrite gets its hash the first time it signs in here.
-- Run once per branch: psql "$DATABASE_URL" -f db/002_users.sql (safe to run again).

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  email         varchar(320) NOT NULL UNIQUE,
  name          varchar(128) NOT NULL,
  password_hash text,
  member        boolean NOT NULL DEFAULT true,
  prefs         jsonb NOT NULL DEFAULT '{}'
);
