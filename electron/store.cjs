// The desktop app's project database (SQLite, built into Electron's Node): settings, projects, conversations,
// and a version history of every project (project.json and index.html at each edit and each AI turn).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

let db = null;

function open(dir) {
  db = new DatabaseSync(path.join(dir, 'reelforge.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      at INTEGER NOT NULL,
      label TEXT NOT NULL,
      project_json TEXT,
      index_html TEXT
    );
    CREATE INDEX IF NOT EXISTS history_project ON history(project, id);
  `);
  return db;
}

const parse = (row) => (row ? JSON.parse(row.value) : undefined);

const kv = {
  get: (key) => parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)),
  set: (key, value) => {
    db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value ?? null));
  },
  del: (key) => {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
  values: (prefix) => db.prepare("SELECT value FROM kv WHERE key >= ? AND key < ? ORDER BY key").all(prefix, `${prefix}￿`).map(parse),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM kv').get().n,
  /** One-time move of the browser storage this app used before, in one transaction. */
  importAll: (entries) => {
    const put = db.prepare('INSERT OR IGNORE INTO kv(key, value) VALUES(?, ?)');
    db.exec('BEGIN');
    try {
      for (const [k, v] of entries) put.run(k, JSON.stringify(v ?? null));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};

const KEEP = 200;
const history = {
  /** Saves a version unless it's identical to the last one. Keeps the newest 200 per project. */
  add: (project, label, projectJson, indexHtml) => {
    const last = db.prepare('SELECT project_json, index_html FROM history WHERE project = ? ORDER BY id DESC LIMIT 1').get(project);
    if (last && last.project_json === projectJson && last.index_html === indexHtml) return null;
    const r = db.prepare('INSERT INTO history(project, at, label, project_json, index_html) VALUES(?, ?, ?, ?, ?)').run(project, Date.now(), String(label).slice(0, 120), projectJson, indexHtml);
    db.prepare('DELETE FROM history WHERE project = ? AND id NOT IN (SELECT id FROM history WHERE project = ? ORDER BY id DESC LIMIT ?)').run(project, project, KEEP);
    return Number(r.lastInsertRowid);
  },
  list: (project) => db.prepare('SELECT id, at, label FROM history WHERE project = ? ORDER BY id DESC').all(project).map((r) => ({ id: Number(r.id), at: Number(r.at), label: r.label })),
  get: (id) => {
    const r = db.prepare('SELECT project, project_json, index_html FROM history WHERE id = ?').get(id);
    return r ? { project: r.project, projectJson: r.project_json, indexHtml: r.index_html } : null;
  },
  drop: (project) => {
    db.prepare('DELETE FROM history WHERE project = ?').run(project);
  },
};

module.exports = { open, kv, history };
