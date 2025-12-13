const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbFile = path.join(__dirname, 'pa_safe.db');
const db = new sqlite3.Database(dbFile);

function init() {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');

    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        emergency_contacts TEXT,
        identity_card_id TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        hw_serial TEXT UNIQUE,
        public_key TEXT,
        last_seen INTEGER,
        status TEXT,
        FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS readings (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        type TEXT,
        value REAL,
        raw TEXT,
        lat REAL,
        lon REAL,
        acc REAL,
        ts INTEGER,
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        user_id TEXT,
        type TEXT,
        value REAL,
        lat REAL,
        lon REAL,
        status TEXT,
        created_at INTEGER,
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        command TEXT,
        payload TEXT,
        status TEXT,
        created_at INTEGER,
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
      )
    `);

    db.run(
      `CREATE INDEX IF NOT EXISTS idx_readings_device_ts
       ON readings(device_id, ts)`
    );

    db.run(
      `CREATE INDEX IF NOT EXISTS idx_alerts_device_created
       ON alerts(device_id, created_at)`
    );
  });
}

module.exports = { db, init };
