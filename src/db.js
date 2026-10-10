'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PALETTE = ['#2F7D5B', '#B5525A', '#3F6C9E', '#C08A1E', '#7A5A9E', '#3D8A8A', '#A8613A', '#5E6E2E'];

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'rieger-house.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS responses (
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
    CREATE INDEX IF NOT EXISTS responses_date ON responses(date);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);
  return db;
}

function nextColor(db) {
  const used = new Set(db.prepare('SELECT color FROM users WHERE active = 1').all().map((r) => r.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

module.exports = { open, nextColor, PALETTE };
