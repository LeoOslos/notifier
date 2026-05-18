'use strict';

const https    = require('https');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const Database = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';
const DB_PATH          = process.env.DB_PATH             || path.join(__dirname, 'queue.db');
const POLL_INTERVAL    = parseInt(process.env.POLL_INTERVAL || '2000');
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES   || '3');
const BATCH_SIZE       = parseInt(process.env.BATCH_SIZE    || '10');
const TTS_PORT         = parseInt(process.env.TTS_PORT      || '9876');
const TTS_LANG         = process.env.TTS_LANG               || 'es';
const DISCOVERY_INTERVAL = parseInt(process.env.DISCOVERY_INTERVAL || '300000'); // 5 min

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── DB ────────────────────────────────────────────────────────────────────────
function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
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

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       message.slice(0, 4096),
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

// ── TTS HTTP server ───────────────────────────────────────────────────────────
function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function startTtsServer() {
  const server = http.createServer((req, res) => {
    const filename = path.basename(req.url);
    if (!filename.startsWith('notifier_tts_') || !filename.endsWith('.mp3')) {
      res.writeHead(404); res.end(); return;
    }
    const filepath = path.join(os.tmpdir(), filename);
    if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(filepath).pipe(res);
  });
  server.listen(TTS_PORT, () => log(`TTS server en :${TTS_PORT}`));
  return server;
}

// ── mDNS discovery ────────────────────────────────────────────────────────────
let discoveredDevices = []; // [{ name, ip }]
let scanning = false;

function discoverDevices() {
  if (scanning) return;
  scanning = true;

  const { Bonjour } = require('bonjour-service');
  const bonjour = new Bonjour();
  const found   = [];

  const browser = bonjour.find({ type: 'googlecast' }, (service) => {
    const ip = (service.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (ip && !found.some(d => d.ip === ip)) {
      found.push({ name: service.name, ip });
    }
  });

  setTimeout(() => {
    browser.stop();
    bonjour.destroy();
    scanning = false;
    if (found.length) {
      discoveredDevices = found;
      log(`Google Home: ${found.map(d => `${d.name}(${d.ip})`).join(', ')}`);
    } else {
      log('Google Home: ningún dispositivo encontrado por mDNS');
    }
  }, 5000);
}

function startDiscovery() {
  discoverDevices();
  setInterval(discoverDevices, DISCOVERY_INTERVAL);
}

// ── Google Home ───────────────────────────────────────────────────────────────
function generateTts(message) {
  const gtts     = require('node-gtts')(TTS_LANG);
  const filename = `notifier_tts_${Date.now()}.mp3`;
  const filepath = path.join(os.tmpdir(), filename);
  return new Promise((resolve, reject) => {
    gtts.save(filepath, message, (err) => {
      if (err) reject(err);
      else resolve({ filename, filepath });
    });
  });
}

function castToDevice(deviceIp, audioUrl) {
  const { Client, DefaultMediaReceiver } = require('castv2-client');
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer  = setTimeout(() => {
      client.close();
      reject(new Error(`timeout conectando a ${deviceIp}`));
    }, 15000);

    client.connect(deviceIp, () => {
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) { clearTimeout(timer); client.close(); return reject(err); }
        player.load(
          { contentId: audioUrl, contentType: 'audio/mpeg', streamType: 'BUFFERED' },
          { autoplay: true },
          (err) => {
            if (err) { clearTimeout(timer); client.close(); return reject(err); }
            player.on('status', (s) => {
              if (s.playerState === 'IDLE') {
                clearTimeout(timer); client.close(); resolve();
              }
            });
          }
        );
      });
    });

    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function sendGoogleHome(message) {
  if (!discoveredDevices.length) throw new Error('No hay dispositivos Google Home descubiertos');

  const localIp                = getLocalIp();
  const { filename, filepath } = await generateTts(message);
  const audioUrl               = `http://${localIp}:${TTS_PORT}/${filename}`;
  log(`TTS url: ${audioUrl}`);

  const results = await Promise.allSettled(
    discoveredDevices.map(d => castToDevice(d.ip, audioUrl))
  );

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) {
    log(`${failures.length} dispositivo(s) fallaron, redescubriendo...`);
    discoverDevices();
    if (failures.length === discoveredDevices.length)
      throw new Error(failures.map(f => f.reason.message).join('; '));
  }

  setTimeout(() => { try { fs.unlinkSync(filepath); } catch {} }, 30000);
}

// ── Process batch ─────────────────────────────────────────────────────────────
async function processBatch(db) {
  const rows = db.prepare(`
    SELECT * FROM queue
    WHERE status = 'pending' AND retries < ?
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(MAX_RETRIES, BATCH_SIZE);

  for (const row of rows) {
    try {
      if (row.channel === 'telegram')    await sendTelegram(row.message);
      if (row.channel === 'google_home') await sendGoogleHome(row.message);
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

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log('ERROR: faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  const db = initDb();
  startTtsServer();
  startDiscovery();
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
