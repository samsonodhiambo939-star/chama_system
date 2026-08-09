require('dotenv').config();
const Database = require('better-sqlite3');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: Set DATABASE_URL environment variable');
    process.exit(1);
  }

  const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sqlite = new Database('./chama.db', { readonly: true });

  console.log('Creating tables in PostgreSQL...');
  await pg.query(`
    CREATE TABLE IF NOT EXISTS members (id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, phone TEXT, member_number TEXT UNIQUE NOT NULL, is_active INTEGER DEFAULT 1, photo TEXT, outside_nairobi INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')), admin_role TEXT CHECK(admin_role IN ('chairman', 'treasurer', 'secretary', 'welfare')), member_id INTEGER REFERENCES members(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS fund_types (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT);
    CREATE TABLE IF NOT EXISTS cycles (id SERIAL PRIMARY KEY, start_date TEXT NOT NULL, end_date TEXT NOT NULL, is_open INTEGER DEFAULT 1, is_processed INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS contributions (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, fund_type_id INTEGER NOT NULL REFERENCES fund_types(id), cycle_id INTEGER NOT NULL REFERENCES cycles(id), amount REAL NOT NULL DEFAULT 0, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW(), UNIQUE(member_id, fund_type_id, cycle_id));
    CREATE TABLE IF NOT EXISTS member_balances (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, fund_type_id INTEGER NOT NULL REFERENCES fund_types(id), balance REAL NOT NULL DEFAULT 0, UNIQUE(member_id, fund_type_id));
    CREATE TABLE IF NOT EXISTS loans (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, amount REAL NOT NULL, interest_rate REAL DEFAULT 10, amount_due REAL NOT NULL, issued_date TEXT, due_date TEXT, approved_date TEXT, status TEXT DEFAULT 'pending', paid_amount REAL DEFAULT 0, defaulted_penalty REAL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS fines (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, amount REAL NOT NULL, balance REAL NOT NULL, reason TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS member_cards (id SERIAL PRIMARY KEY, member_id INTEGER UNIQUE NOT NULL REFERENCES members(id) ON DELETE CASCADE, assigned_amount REAL NOT NULL DEFAULT 0, paid_amount REAL NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS payment_requests (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, payment_type TEXT NOT NULL CHECK(payment_type IN ('fine', 'member_card', 'loan')), reference_id INTEGER, amount REAL NOT NULL, status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')), created_at TIMESTAMP DEFAULT NOW(), approved_at TIMESTAMP);
    CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, member_id INTEGER REFERENCES members(id) ON DELETE CASCADE, user_id INTEGER, title TEXT NOT NULL, message TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'info', is_read INTEGER DEFAULT 0, link TEXT, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS withdrawal_requests (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, fund_type_id INTEGER NOT NULL REFERENCES fund_types(id), amount REAL NOT NULL, status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')), approval_level TEXT DEFAULT 'pending' CHECK(approval_level IN ('pending','pending_chairman','pending_treasurer','approved','rejected')), created_at TIMESTAMP DEFAULT NOW(), approved_at TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit_logs (id SERIAL PRIMARY KEY, user_id INTEGER, username TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, details TEXT, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS welfare_requests (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, amount REAL NOT NULL, reason TEXT NOT NULL, beneficiary_name TEXT NOT NULL, beneficiary_id_number TEXT NOT NULL, relationship TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')), reviewed_by INTEGER REFERENCES users(id), review_notes TEXT, created_at TIMESTAMP DEFAULT NOW(), reviewed_at TIMESTAMP);
    CREATE TABLE IF NOT EXISTS meeting_minutes (id SERIAL PRIMARY KEY, title TEXT NOT NULL, meeting_date TEXT NOT NULL, content TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS welfare_registrations (id SERIAL PRIMARY KEY, member_id INTEGER UNIQUE NOT NULL REFERENCES members(id) ON DELETE CASCADE, status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'locked')), locked INTEGER DEFAULT 0, edit_requested INTEGER DEFAULT 0, form_data TEXT, submitted_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS meeting_attendance (id SERIAL PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meeting_minutes(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present', 'absent', 'excused')), late INTEGER DEFAULT 0, no_card INTEGER DEFAULT 0, no_neck_card INTEGER DEFAULT 0, UNIQUE(meeting_id, member_id));
    CREATE TABLE IF NOT EXISTS fine_rules (id SERIAL PRIMARY KEY, rule_name TEXT UNIQUE NOT NULL, amount REAL NOT NULL, description TEXT, is_active INTEGER DEFAULT 1);
  `);
  console.log('Tables created.');

  console.log('Starting data migration...');
  const tables = [
    'fund_types', 'members', 'users', 'cycles', 'contributions', 'member_balances',
    'loans', 'fines', 'member_cards', 'payment_requests', 'notifications',
    'withdrawal_requests', 'audit_logs', 'welfare_requests', 'meeting_minutes',
    'welfare_registrations', 'meeting_attendance', 'fine_rules'
  ];

  for (const table of tables) {
    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
    if (rows.length === 0) { console.log(`  ${table}: empty`); continue; }

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const colNames = columns.map(c => `"${c}"`).join(', ');
    const insertSQL = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    for (const row of rows) {
      const values = columns.map(c => {
        const v = row[c];
        if (v === true) return true;
        if (v === false) return false;
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return v;
        return String(v);
      });
      try { await pg.query(insertSQL, values); } catch(e) {
        console.error(`  ${table} insert error: ${e.message.substring(0, 80)}`);
      }
    }
    console.log(`  ${table}: ${rows.length} rows`);
  }

  // Reset sequences
  console.log('Resetting sequences...');
  const seqTables = ['members', 'users', 'cycles', 'contributions', 'member_balances',
    'loans', 'fines', 'member_cards', 'payment_requests', 'notifications',
    'withdrawal_requests', 'audit_logs', 'welfare_requests', 'meeting_minutes',
    'welfare_registrations', 'meeting_attendance', 'fine_rules'];
  for (const table of seqTables) {
    await pg.query(`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM "${table}"), 1))`);
  }

  await pg.end(); sqlite.close();
  console.log('\nMigration complete!');
}

migrate().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
