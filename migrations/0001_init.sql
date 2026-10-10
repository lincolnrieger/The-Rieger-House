-- The Rieger House schema.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  pin_hash        TEXT,
  color           TEXT NOT NULL,
  on_dinner_list  INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE responses (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  home        INTEGER,
  going_out   INTEGER NOT NULL DEFAULT 0,
  out_what    TEXT NOT NULL DEFAULT '',
  out_time    TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  updated_by  INTEGER,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX responses_date ON responses(date);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- PIN attempts per IP address, to slow down guessing.
CREATE TABLE throttle (
  ip        TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
);
