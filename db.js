const { createClient } = require('@libsql/client');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(dataDir, 'finance.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient(authToken ? { url, authToken } : { url });

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function migrateBudgetsTable() {
  const info = await client.execute(`PRAGMA table_info(budgets)`);
  const columns = info.rows.map((r) => r.name);

  if (columns.length === 0) {
    await client.execute(`
      CREATE TABLE budgets (
        category TEXT NOT NULL,
        month TEXT NOT NULL,
        monthly_limit REAL NOT NULL,
        PRIMARY KEY (category, month)
      )
    `);
    return;
  }

  if (!columns.includes('month')) {
    const old = await client.execute(`SELECT * FROM budgets`);
    await client.execute(`ALTER TABLE budgets RENAME TO budgets_old`);
    await client.execute(`
      CREATE TABLE budgets (
        category TEXT NOT NULL,
        month TEXT NOT NULL,
        monthly_limit REAL NOT NULL,
        PRIMARY KEY (category, month)
      )
    `);
    const thisMonth = currentMonthKey();
    for (const row of old.rows) {
      await client.execute({
        sql: `INSERT INTO budgets (category, month, monthly_limit) VALUES (?, ?, ?)`,
        args: [row.category, thisMonth, row.monthly_limit],
      });
    }
    await client.execute(`DROP TABLE budgets_old`);
  }
}

async function init() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await migrateBudgetsTable();
  await client.execute(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0,
      deadline TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS allocation_rules (
      category TEXT PRIMARY KEY,
      percent REAL NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS recurring_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      start_month TEXT NOT NULL,
      end_month TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS recurring_budget_log (
      rule_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      PRIMARY KEY (rule_id, month)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS rollover_categories (
      category TEXT PRIMARY KEY
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS rollover_log (
      category TEXT NOT NULL,
      month TEXT NOT NULL,
      PRIMARY KEY (category, month)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS recurring_income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      start_month TEXT NOT NULL,
      end_month TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS recurring_income_log (
      rule_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      PRIMARY KEY (rule_id, month)
    )
  `);
}

async function run(sql, args = []) {
  return client.execute({ sql, args });
}

async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0] || null;
}

module.exports = { client, init, run, all, get };
