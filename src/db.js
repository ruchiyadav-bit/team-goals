// Database initialization: schema, admin seed, default verticals.
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const DEFAULT_VERTICALS = ['CPS', 'iGaming', 'Nutra', 'Coupon', 'Pay Per Call', 'MetAds'];

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','manager','leader','member')),
      vertical TEXT,
      leader_id INTEGER REFERENCES users(id),
      manager_id INTEGER REFERENCES users(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS months (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      month TEXT NOT NULL,                       -- YYYY-MM
      goal_spend REAL NOT NULL DEFAULT 0,
      goal_revenue REAL NOT NULL DEFAULT 0,
      goal_profit REAL NOT NULL DEFAULT 0,
      weeks INTEGER NOT NULL DEFAULT 4,
      weekly TEXT NOT NULL DEFAULT '[]',         -- JSON [{spend,revenue,profit,reason,note} | null]
      meetings TEXT NOT NULL DEFAULT '[]',       -- JSON [{date,text,author}]
      goal_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (goal_status IN ('draft','pending_leader','pending_admin','approved','rejected')),
      goal_remark TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      self_review TEXT,
      updated_at TEXT,
      UNIQUE (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      month TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES users(id),
      rating INTEGER CHECK (rating BETWEEN 1 AND 5),
      text TEXT,
      is_self INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      month TEXT NOT NULL,
      week_index INTEGER,
      author_id INTEGER NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verticals (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','pending')),
      requested_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      brand TEXT,
      vertical TEXT,
      discount TEXT,
      valid_from TEXT,
      expiry TEXT,
      assigned_to INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','expired','used')),
      note TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    -- Append-only audit log. No UPDATE/DELETE is ever issued against it by the app,
    -- and triggers below make it immutable even via stray SQL.
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor_id INTEGER,
      actor_name TEXT,
      action TEXT NOT NULL,
      target_user INTEGER,
      month TEXT,
      detail TEXT
    );

    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

    CREATE INDEX IF NOT EXISTS idx_months_user ON months(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_comments_um ON comments(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_reviews_um ON reviews(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
  `);

  // Seed first admin
  const admin = db.prepare("SELECT id FROM users WHERE role='admin'").get();
  if (!admin) {
    const pw = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare(
      'INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?,?,?,?,?)'
    ).run('admin', bcrypt.hashSync(pw, 10), 'Administrator', 'admin', new Date().toISOString());
    console.log(`Seeded admin account -> username: admin  password: ${pw}  (change it after first login)`);
  }

  // Seed default verticals
  const insV = db.prepare(
    "INSERT OR IGNORE INTO verticals (name, status, created_at) VALUES (?, 'approved', ?)"
  );
  for (const v of DEFAULT_VERTICALS) insV.run(v, new Date().toISOString());

  return db;
}

module.exports = { initDb, getJwtSecret, DATA_DIR };
