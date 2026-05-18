'use strict';

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';
const DB_PATH         = process.env.DB_PATH || path.join(__dirname, 'queue.db');
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL  || '2000');
const MAX_RETRIES     = parseInt(process.env.MAX_RETRIES    || '3');
const BATCH_SIZE      = parseInt(process.env.BATCH_SIZE     || '10');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');  // permite escrituras concurrentes de otros procesos
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel    TEXT    NOT NULL DEFAULT 'telegram',
      message    TEXT    NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 5,
      status     TEXT    NOT NULL DEFAULT 'pending',
      retries    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      sent_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending ON queue(status, priority, created_at);
  `);
  return db;
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       message.slice(0, 4096),  // límite de Telegram
      parse_mode: 'HTML'
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.ok) resolve();
        else reject(new Error(`Telegram: ${parsed.description} (${parsed.error_code})`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function processBatch(db) {
  const rows = db.prepare(`
    SELECT * FROM queue
    WHERE status = 'pending' AND retries < ?
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(MAX_RETRIES, BATCH_SIZE);

  for (const row of rows) {
    try {
      if (row.channel === 'telegram') await sendTelegram(row.message);
      db.prepare(`UPDATE queue SET status='sent', sent_at=datetime('now') WHERE id=?`).run(row.id);
      log(`sent id=${row.id} channel=${row.channel}`);
    } catch (err) {
      const retries   = row.retries + 1;
      const newStatus = retries >= MAX_RETRIES ? 'failed' : 'pending';
      db.prepare(`UPDATE queue SET retries=?, status=? WHERE id=?`).run(retries, newStatus, row.id);
      log(`error id=${row.id} retries=${retries} status=${newStatus} — ${err.message}`);
    }
  }
}

function main() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log('ERROR: faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  const db = initDb();
  log(`iniciado | db=${DB_PATH} | poll=${POLL_INTERVAL}ms | max_retries=${MAX_RETRIES}`);

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try   { await processBatch(db); }
    catch (err) { log(`processBatch error: ${err.message}`); }
    finally { busy = false; }
  }, POLL_INTERVAL);

  const shutdown = () => { db.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main();
