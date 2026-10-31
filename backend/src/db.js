const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function openDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      phone      TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sites (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      address     TEXT NOT NULL,
      phone       TEXT NOT NULL,              -- WhatsApp / contact number drivers message
      owner_phone TEXT NOT NULL REFERENCES operators(phone),
      cap_kw      REAL NOT NULL,
      chargers    TEXT NOT NULL,              -- JSON [{id,maxKw}]
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(owner_phone);

    CREATE TABLE IF NOT EXISTS bookings (
      id           TEXT PRIMARY KEY,
      site_id      TEXT NOT NULL REFERENCES sites(id),
      site_name    TEXT NOT NULL,
      vehicle      TEXT NOT NULL,
      vehicle_key  TEXT NOT NULL,
      energy_kwh   REAL NOT NULL,
      arrival_at   INTEGER NOT NULL,
      deadline_at  INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      status       TEXT NOT NULL,             -- waiting | confirmed | delayed | done | cancelled
      reason_key   TEXT,
      charger      TEXT,
      start_at     INTEGER,
      complete_at  INTEGER,
      profile      TEXT NOT NULL DEFAULT '[]', -- JSON [{from,to,kw}]
      late_min     INTEGER NOT NULL DEFAULT 0,
      penalized    INTEGER NOT NULL DEFAULT 0,
      cancel_hash  TEXT NOT NULL              -- sha256 of the driver's cancel token
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_site_status ON bookings(site_id, status);

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      site_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      vehicle     TEXT,
      charger     TEXT,
      start_at    INTEGER,
      complete_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts DESC);

    CREATE TABLE IF NOT EXISTS otps (
      phone      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      sent_at    INTEGER NOT NULL
    );
  `);
  return db;
}

module.exports = { openDb };
