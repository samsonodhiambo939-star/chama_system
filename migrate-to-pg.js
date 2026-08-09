require('dotenv').config();
const Database = require('better-sqlite3');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: Set DATABASE_URL environment variable to the Render PostgreSQL connection string');
    process.exit(1);
  }

  const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sqlite = new Database('./chama.db', { readonly: true });

  console.log('Connected to both databases. Starting migration...');

  const tables = [
    'fund_types',
    'members',
    'users',
    'cycles',
    'contributions',
    'member_balances',
    'loans',
    'fines',
    'member_cards',
    'payment_requests',
    'notifications',
    'withdrawal_requests',
    'audit_logs',
    'welfare_requests',
    'meeting_minutes',
    'welfare_registrations',
    'meeting_attendance',
    'fine_rules'
  ];

  for (const table of tables) {
    console.log(`Migrating ${table}...`);
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    
    if (rows.length === 0) {
      console.log(`  ${table}: empty, skipping`);
      continue;
    }

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const colNames = columns.map(c => `"${c}"`).join(', ');
    const insertSQL = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    for (const row of rows) {
      const values = columns.map(c => row[c]);
      try {
        await pg.query(insertSQL, values);
      } catch (e) {
        console.error(`  Error inserting into ${table}:`, e.message.substring(0, 100));
      }
    }
    console.log(`  ${table}: ${rows.length} rows migrated`);
  }

  // Reset sequences
  const seqTables = ['members', 'users', 'cycles', 'contributions', 'member_balances', 
    'loans', 'fines', 'member_cards', 'payment_requests', 'notifications', 
    'withdrawal_requests', 'audit_logs', 'welfare_requests', 'meeting_minutes',
    'welfare_registrations', 'meeting_attendance', 'fine_rules'];

  for (const table of seqTables) {
    await pg.query(`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM "${table}"), 1))`);
  }

  await pg.end();
  sqlite.close();
  console.log('Migration complete!');
}

migrate().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
