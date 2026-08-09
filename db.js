const path = require('path');

let db;

if (process.env.DATABASE_URL) {
  // PostgreSQL (production)
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let txClient = null;

  class PgStmt {
    constructor(sql) { 
      let idx = 0;
      this.sql = sql.replace(/\?/g, () => `$${++idx}`)
                    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
    }
    _conn() { return txClient || pool; }
    async get(...params) {
      const r = await this._conn().query(this.sql, params.length > 0 && params[0] !== undefined ? params : undefined);
      return r.rows[0] || null;
    }
    async all(...params) {
      const r = await this._conn().query(this.sql, params.length > 0 && params[0] !== undefined ? params : undefined);
      return r.rows;
    }
    async run(...params) {
      const r = await this._conn().query(this.sql, params.length > 0 && params[0] !== undefined ? params : undefined);
      return { lastInsertRowid: r.rows[0]?.id, changes: r.rowCount };
    }
  }

  db = {
    prepare(sql) { return new PgStmt(sql); },
    exec(sql) { return pool.query(sql); },
    transaction(fn) {
      return async (...args) => {
        const client = await pool.connect();
        txClient = client;
        try {
          await client.query('BEGIN');
          const result = await fn(...args);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          txClient = null;
          client.release();
        }
      };
    },
    _pool: pool,
    _isPg: true
  };

} else {
  // SQLite (local development)
  const Database = require('better-sqlite3');
  const dbPath = path.join(__dirname, 'chama.db');
  const sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  db = sqliteDb;
}

module.exports = db;