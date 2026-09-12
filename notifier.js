'use strict';

const https      = require('https');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';
const DB_PATH          = process.env.DB_PATH             || path.join(__dirname, 'queue.db');
const POLL_INTERVAL    = parseInt(process.env.POLL_INTERVAL || '2000');
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES   || '3');
const BATCH_SIZE       = parseInt(process.env.BATCH_SIZE    || '10');
const TTS_PORT         = parseInt(process.env.TTS_PORT      || '9876');
const TTS_VOICE        = process.env.TTS_VOICE              || 'es-AR-TomasNeural';
const DND_CHANNELS         = (process.env.DND_CHANNELS || 'google_home').split(',').map(s => s.trim());
const QUEUE_RETENTION_DAYS = parseInt(process.env.QUEUE_RETENTION_DAYS || '30');
const GOOGLE_HOME_DEVICE   = process.env.GOOGLE_HOME_DEVICE || '';
const HA_URL               = process.env.HA_URL             || 'http://localhost:8123';
const HA_TOKEN             = process.env.HA_TOKEN           || '';
// Hook coreográfico: comando opaco a ejecutar cuando una fila analyze=1 pasa a 'sent'.
// Default vacío = no-op. notifier no sabe qué hay del otro lado (ver analyzer agent).
const ANALYZE_HOOK_CMD     = process.env.ANALYZE_HOOK_CMD   || '';
const GMAIL_USER           = process.env.GMAIL_USER         || '';
const GMAIL_APP_PASSWORD   = process.env.GMAIL_APP_PASSWORD || '';

function parseHHMM(val, defaultHour) {
  if (val === undefined) return defaultHour * 60;
  const parts = val.split(':');
  return parseInt(parts[0]) * 60 + (parts[1] ? parseInt(parts[1]) : 0);
}
const DND_START = parseHHMM(process.env.DND_START, 23);
const DND_END   = parseHHMM(process.env.DND_END,   8);

// ── Do Not Disturb ────────────────────────────────────────────────────────────
function isDndTime() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return DND_START > DND_END
    ? minutes >= DND_START || minutes < DND_END
    : minutes >= DND_START && minutes < DND_END;
}

function isInDnd(channel) {
  return DND_CHANNELS.includes(channel) && isDndTime();
}

// ── Timestamp ────────────────────────────────────────────────────────────────
function fmtTime(createdAt) {
  // created_at viene en UTC de SQLite datetime('now') → convertir a hora local
  const d  = new Date(createdAt.replace(' ', 'T') + 'Z');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mo} ${hh}:${mm}`;
}

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
      silent     INTEGER NOT NULL DEFAULT 1,
      analyze    INTEGER NOT NULL DEFAULT 0,
      source     TEXT    NOT NULL DEFAULT 'unknown',
      status     TEXT    NOT NULL DEFAULT 'pending',
      retries    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      sent_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending ON queue(status, priority, created_at);
  `);
  // Migración: agregar columnas si no existen (DBs creadas antes de cada versión)
  try { db.exec(`ALTER TABLE queue ADD COLUMN silent INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
  try { db.exec(`ALTER TABLE queue ADD COLUMN analyze INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { db.exec(`ALTER TABLE queue ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'`); } catch (_) {}
  try { db.exec(`ALTER TABLE queue ADD COLUMN email_to TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  try { db.exec(`ALTER TABLE queue ADD COLUMN email_subject TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  return db;
}

// ── Etiquetado de origen (regla de CLAUDE.md) ─────────────────────────────────
// Toda notificación dice qué proceso la encoló, y si es una prueba lo dice también.
// Las dos cosas se derivan del campo `source` ('proceso' o 'proceso/prueba') y se
// estampan ACÁ, en la salida: el tag no puede depender de que el llamador se acuerde.
const SUFIJO_PRUEBA = '/prueba';

function etiquetas(source) {
  const crudo    = String(source || '').trim();
  const esPrueba = crudo.toLowerCase().endsWith(SUFIJO_PRUEBA);
  let proceso    = (esPrueba ? crudo.slice(0, -SUFIJO_PRUEBA.length) : crudo).replace(/^\/+|\/+$/g, '').trim();
  if (!proceso || proceso.toLowerCase() === 'unknown') proceso = 'desconocido';
  return { proceso, esPrueba };
}

function escaparHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ¿El llamador ya puso el tag adelante? Vale el proceso completo o su última hoja,
// así '[piso_jubilacion]' cuenta como etiquetado de 'finanzas-cuenta/piso_jubilacion'.
function yaEtiquetado(texto, proceso) {
  // El [PRUEBA] va delante del tag de proceso: se saltea para no re-estampar.
  const m = String(texto).replace(/^\s*(?:\[PRUEBA\]\s*)+/i, '').match(/^\s*\[([^\]]+)\]/);
  if (!m) return false;
  const puesto = m[1].trim().toLowerCase();
  return puesto === proceso.toLowerCase() || puesto === proceso.split('/').pop().toLowerCase();
}

// Texto escrito (Telegram, asunto de mail): [PRUEBA] [proceso] mensaje.
function prefijarTexto(texto, { proceso, esPrueba }, { html = false } = {}) {
  let out = String(texto);
  if (!yaEtiquetado(out, proceso)) out = `[${html ? escaparHtml(proceso) : proceso}] ${out}`;
  if (esPrueba && !/\[PRUEBA\]/i.test(out)) out = `[PRUEBA] ${out}`;
  return out;
}

// Parlante: el TTS lee el texto, así que los corchetes sonarían mal → va dicho en palabras.
function prefijarVoz(texto, { proceso, esPrueba }) {
  const nombre = proceso.replace(/[_\-\/]+/g, ' ');
  const partes = [];
  if (esPrueba) partes.push('Atención, esto es una prueba, no es un aviso real.');
  partes.push(`Aviso de ${nombre}.`);
  partes.push(String(texto));
  return partes.join(' ');
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(message, silent = true) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id:              TELEGRAM_CHAT_ID,
      text:                 message.slice(0, 4096),
      parse_mode:           'HTML',
      disable_notification: silent
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

// ── Email ─────────────────────────────────────────────────────────────────────
function isValidEmail(addr) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function sendEmail(to, subject, message) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return Promise.reject(new Error('Email: faltan GMAIL_USER o GMAIL_APP_PASSWORD en .env'));
  }
  if (!isValidEmail(to)) {
    return Promise.reject(new Error(`Email: dirección inválida: ${to}`));
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
  return transporter.sendMail({
    from:    `"notifier" <${GMAIL_USER}>`,
    to,
    subject: subject || '(sin asunto)',
    text:    message
  });
}

// ── TTS HTTP server ───────────────────────────────────────────────────────────
function getLocalIp() {
  const nets = os.networkInterfaces();
  // Preferir interfaz WiFi (wlo1) — los Cast devices están en WiFi y solo alcanzan esa IP
  for (const name of ['wlo1', 'wlan0', 'wlp2s0']) {
    const iface = (nets[name] || []).find(i => i.family === 'IPv4' && !i.internal);
    if (iface) return iface.address;
  }
  // Fallback: primera IP no-loopback
  for (const ifaces of Object.values(nets)) {
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
    const size = fs.statSync(filepath).size;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': size });
    fs.createReadStream(filepath).pipe(res);
  });
  server.listen(TTS_PORT, () => log(`TTS server en :${TTS_PORT}`));
  return server;
}


// ── Google Home ───────────────────────────────────────────────────────────────
function generateTts(message) {
  const { exec } = require('child_process');
  const filename = `notifier_tts_${Date.now()}.mp3`;
  const filepath = path.join(os.tmpdir(), filename);
  return new Promise((resolve, reject) => {
    const cmd = `/home/leoadmin/.local/bin/edge-tts --voice "${TTS_VOICE}" --text "${message.replace(/"/g, '\\"')}" --write-media "${filepath}"`;
    exec(cmd, { timeout: 15000 }, (err) => {
      if (err) reject(err);
      else resolve({ filename, filepath });
    });
  });
}

async function sendLights(priority) {
  const { exec } = require('child_process');
  const scriptPath = path.join(__dirname, 'cast_lights.py');
  await new Promise((resolve, reject) => {
    const env = { ...process.env, HA_URL, HA_TOKEN };
    exec(`python3 "${scriptPath}" "${priority}"`, { timeout: 15000, env }, (err, stdout, stderr) => {
      if (stdout) stdout.trim().split('\n').forEach(l => log(`lights: ${l}`));
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}

async function sendGoogleHome(message) {
  const { exec } = require('child_process');
  const localIp                = getLocalIp();
  const { filename, filepath } = await generateTts(message);
  const audioUrl               = `http://${localIp}:${TTS_PORT}/${filename}`;
  log(`TTS url: ${audioUrl}`);

  const scriptPath   = path.join(__dirname, 'cast_google_home.py');
  const deviceArg    = GOOGLE_HOME_DEVICE ? ` "${GOOGLE_HOME_DEVICE}"` : '';
  await new Promise((resolve, reject) => {
    exec(`python3 "${scriptPath}" "${audioUrl}"${deviceArg}`, { timeout: 60000 }, (err, stdout, stderr) => {
      if (stdout) stdout.trim().split('\n').forEach(l => log(`cast: ${l}`));
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });

  setTimeout(() => { try { fs.unlinkSync(filepath); } catch {} }, 30000);
}

// ── Queue cleanup ─────────────────────────────────────────────────────────────
function purgeOldRecords(db) {
  const { changes } = db.prepare(`
    DELETE FROM queue
    WHERE status IN ('sent', 'failed', 'skipped')
      AND created_at < datetime('now', ? || ' days')
  `).run(`-${QUEUE_RETENTION_DAYS}`);
  if (changes > 0) log(`purge: eliminados ${changes} registros con más de ${QUEUE_RETENTION_DAYS} días`);
}

// ── Analyze hook (coreografía event-driven) ───────────────────────────────────
function fireAnalyzeHook(id) {
  if (!ANALYZE_HOOK_CMD) return;
  const { execFile } = require('child_process');
  // fire-and-forget: no bloquea el dispatch. El launcher serializa (flock) y
  // corre el analyzer en su propio proceso.
  execFile(ANALYZE_HOOK_CMD, [String(id)], { timeout: 0 }, (err) => {
    if (err) log(`analyze-hook id=${id} error: ${err.message}`);
    else     log(`analyze-hook id=${id} ejecutado`);
  });
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
    if (isInDnd(row.channel)) {
      db.prepare(`UPDATE queue SET status='skipped', sent_at=datetime('now') WHERE id=?`).run(row.id);
      log(`dnd: skipped id=${row.id} channel=${row.channel} (DND ${DND_START}-${DND_END}h)`);
      continue;
    }
    try {
      const ts   = fmtTime(row.created_at);
      const tags = etiquetas(row.source);
      if (row.channel === 'telegram') {
        const silent = row.silent || isDndTime();
        await sendTelegram(`[${ts}] ${prefijarTexto(row.message, tags, { html: true })}`, !!silent);
      }
      if (row.channel === 'google_home') await sendGoogleHome(prefijarVoz(row.message, tags));
      if (row.channel === 'lights')      await sendLights(row.priority);
      if (row.channel === 'email')       await sendEmail(row.email_to, prefijarTexto(row.email_subject || '(sin asunto)', tags), row.message);
      db.prepare(`UPDATE queue SET status='sent', sent_at=datetime('now') WHERE id=?`).run(row.id);
      log(`sent id=${row.id} channel=${row.channel} silent=${row.silent} source=${tags.proceso}${tags.esPrueba ? ' PRUEBA' : ''}`);
      // Coreografía: si el evento pide análisis, disparar el hook recién ahora
      // (status='sent' garantiza que el incidente ya se entregó antes del análisis).
      if (row.analyze) fireAnalyzeHook(row.id);
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
  log(`iniciado | db=${DB_PATH} | poll=${POLL_INTERVAL}ms | max_retries=${MAX_RETRIES} | tts_ip=${getLocalIp()} | retention=${QUEUE_RETENTION_DAYS}d`);

  purgeOldRecords(db);
  setInterval(() => purgeOldRecords(db), 60 * 60 * 1000);

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

// Solo arranca el daemon si se ejecuta como programa: `require` (tests) no debe
// levantar el poll contra la cola real.
if (require.main === module) main();

// Exportado solo para los tests de etiquetado (test_etiquetas.js).
module.exports = { etiquetas, prefijarTexto, prefijarVoz, yaEtiquetado };
