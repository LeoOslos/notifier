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
// Reintentos (BL-279). Una falla transitoria (sin red, timeout, 5xx, 429) no gasta MAX_RETRIES:
// se reintenta con espera creciente hasta que vence el aviso, como la cola de Postfix
// (minimal/maximal_backoff_time + maximal_queue_lifetime). MAX_RETRIES queda para las fallas
// permanentes (token o dirección inválidos, mensaje rechazado), donde insistir no sirve.
const REINTENTO_BASE_S     = parseInt(process.env.REINTENTO_BASE_S     || '30');
const REINTENTO_MAX_S      = parseInt(process.env.REINTENTO_MAX_S      || '900');
// Texto (telegram, email): sirve si llega algo tarde, no horas después (un aviso describe el estado
// del momento; ver README, «Un aviso que no salió»). Voz y luces: solo si es casi en el momento.
const VENCIMIENTO_TEXTO_H  = parseFloat(process.env.VENCIMIENTO_TEXTO_H || '3');
const VENCIMIENTO_AL_OIDO_MIN = parseFloat(process.env.VENCIMIENTO_AL_OIDO_MIN || '30');
const CANALES_AL_OIDO      = ['google_home', 'wiim', 'lights'];
// Desde cuánto atraso la entrega lo dice (⏰ en el texto, «aviso atrasado» en la voz).
const ATRASO_MIN           = parseFloat(process.env.ATRASO_MIN || '10');
const TTS_PORT         = parseInt(process.env.TTS_PORT      || '9876');
// Voz principal: Gemini TTS. Si falla por cualquier motivo (sin internet, cuota, API), Piper local.
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY       || '';
const GEMINI_TTS_MODEL   = process.env.GEMINI_TTS_MODEL     || 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE   = process.env.GEMINI_TTS_VOICE     || 'Kore';
const GEMINI_TTS_TIMEOUT = parseInt(process.env.GEMINI_TTS_TIMEOUT || '30000');
const PIPER_BIN          = process.env.PIPER_BIN            || path.join(__dirname, 'piper-venv', 'bin', 'piper');
const PIPER_MODEL        = process.env.PIPER_MODEL          || path.join(__dirname, 'voces', 'es_AR-daniela-high.onnx');
const PIPER_LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE   || '1.5';   // >1 = más lento
const DND_CHANNELS         = (process.env.DND_CHANNELS || 'google_home,wiim').split(',').map(s => s.trim());
const QUEUE_RETENTION_DAYS = parseInt(process.env.QUEUE_RETENTION_DAYS || '30');
const GOOGLE_HOME_DEVICE   = process.env.GOOGLE_HOME_DEVICE || '';
const WIIM_HOST            = process.env.WIIM_HOST          || '192.168.1.147';
// Sonido previo al aviso en el WiiM (fuera de Git: ver README). Si no existe, el aviso sale sin él.
const WIIM_CHIME           = process.env.WIIM_CHIME         || path.join(__dirname, 'sonidos', 'chime.mp3');
// El WiiM deja de sonar ~0,75 s antes del final del archivo (medido con getPlayerStatus, BL-216) y
// Gemini deja solo 80-320 ms de silencio al final: sin relleno se come la última palabra.
const WIIM_RELLENO_MS      = parseInt(process.env.WIIM_RELLENO_MS || '1500');
// Volumen de los avisos por voz (BL-237): se fija antes de hablar (sacando el mute) y al terminar
// se devuelve el que había. Vacío = no tocar el volumen.
const GOOGLE_HOME_VOLUMEN  = process.env.GOOGLE_HOME_VOLUMEN ?? '0.5';   // 0-1, escala de Cast
const WIIM_VOLUMEN         = process.env.WIIM_VOLUMEN        ?? '40';    // 0-100, escala del WiiM
const HA_URL               = process.env.HA_URL             || 'http://localhost:8123';
const HA_TOKEN             = process.env.HA_TOKEN           || '';
// luces-musica tiene tomado este flock mientras las LIFX siguen la música (su contrato, BL-215).
const LUCES_MUSICA_LOCK    = process.env.LUCES_MUSICA_LOCK  || path.join(os.homedir(), 'luces-musica', 'datos', 'corriendo.lock');
// Un aviso a varios canales son filas sueltas: se reconoce la de Telegram por source+texto+hora.
const MISMO_AVISO_S        = 60;
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
// Formato estándar (registro_log.js, ~/planes/PLAN-estandarizar-logs.md). pm2 ya no le antepone fecha (`time: false`).
// Nivel por el contenido, como ya estaban escritos los mensajes: los que dicen «error» van como ERROR.
const _registro = require('./registro_log').crearLog('notifier');
function log(msg) {
  (/\berror\b/i.test(msg) ? _registro.error : _registro.info)(msg);
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
  // UTC como created_at. NULL = se puede mandar ya.
  try { db.exec(`ALTER TABLE queue ADD COLUMN next_attempt_at TEXT`); } catch (_) {}
  // Mensaje del último intento fallido: dice por qué un aviso quedó failed/expired.
  try { db.exec(`ALTER TABLE queue ADD COLUMN last_error TEXT`); } catch (_) {}
  return db;
}

// ── Reintentos y atraso (BL-279) ──────────────────────────────────────────────
// created_at y next_attempt_at son UTC de SQLite ('AAAA-MM-DD HH:MM:SS', sin zona).
const desdeSqlite = s => new Date(s.replace(' ', 'T') + 'Z');
const aSqlite     = d => d.toISOString().slice(0, 19).replace('T', ' ');

// Espera antes del intento número `intento` (1 = el primero que falló): 30 s, 60 s, 120 s… tope 15 min.
function esperaS(intento) {
  return Math.min(REINTENTO_BASE_S * 2 ** Math.max(0, intento - 1), REINTENTO_MAX_S);
}

function vencimientoMs(channel) {
  return CANALES_AL_OIDO.includes(channel) ? VENCIMIENTO_AL_OIDO_MIN * 60e3 : VENCIMIENTO_TEXTO_H * 3600e3;
}

function vencido(row, ahora = new Date()) {
  return ahora - desdeSqlite(row.created_at) > vencimientoMs(row.channel);
}

function atrasado(row, ahora = new Date()) {
  return ahora - desdeSqlite(row.created_at) > ATRASO_MIN * 60e3;
}

// Qué hacer con una fila cuyo envío falló: { status, retries, next_attempt_at }.
// 'failed' = algo está roto (hay que arreglarlo); 'expired' = no hubo red a tiempo (nada que arreglar).
function trasFalla(row, err, ahora = new Date()) {
  const retries = row.retries + 1;
  if (err && err.permanente && retries >= MAX_RETRIES) return { status: 'failed', retries, next_attempt_at: null, motivo: 'permanente' };
  const proximo = new Date(ahora.getTime() + esperaS(retries) * 1000);
  if (proximo - desdeSqlite(row.created_at) > vencimientoMs(row.channel)) {
    return { status: 'expired', retries, next_attempt_at: null, motivo: 'vencido' };
  }
  return { status: 'pending', retries, next_attempt_at: aSqlite(proximo), motivo: null };
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
        let parsed;
        try { parsed = JSON.parse(data); }
        catch (_) { return reject(new Error(`Telegram: respuesta no JSON (HTTP ${res.statusCode})`)); }
        if (parsed.ok) return resolve();
        const err = new Error(`Telegram: ${parsed.description} (${parsed.error_code})`);
        // 4xx es el mensaje o el token, salvo 429 (límite de envío): reintentar no lo arregla.
        err.permanente = parsed.error_code >= 400 && parsed.error_code < 500 && parsed.error_code !== 429;
        reject(err);
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
  const permanente = msg => Object.assign(new Error(msg), { permanente: true });
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return Promise.reject(permanente('Email: faltan GMAIL_USER o GMAIL_APP_PASSWORD en .env'));
  }
  if (!isValidEmail(to)) {
    return Promise.reject(permanente(`Email: dirección inválida: ${to}`));
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
  }).catch(err => {
    // Autenticación o rechazo definitivo del servidor (5xx SMTP); el resto (red, 4xx) es transitorio.
    err.permanente = err.code === 'EAUTH' || err.responseCode >= 500;
    throw err;
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
    const tipo     = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }[path.extname(filename)];
    const esChime  = filename === path.basename(WIIM_CHIME);
    if (!(filename.startsWith('notifier_tts_') || esChime) || !tipo) {
      res.writeHead(404); res.end(); return;
    }
    const filepath = esChime ? WIIM_CHIME : path.join(os.tmpdir(), filename);
    if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(filepath).size;
    res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': size });
    fs.createReadStream(filepath).pipe(res);
  });
  server.listen(TTS_PORT, () => log(`TTS server en :${TTS_PORT}`));
  return server;
}


// ── Google Home ───────────────────────────────────────────────────────────────
// Encabezado WAV para PCM 16 bit mono (Gemini devuelve PCM crudo, sin contenedor).
function wavDePcm(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function ttsGemini(message, filepath) {
  if (!GEMINI_API_KEY) return Promise.reject(new Error('falta GEMINI_API_KEY'));
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `Leé en voz alta, en español rioplatense de Argentina, con tono claro de aviso: ${message}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } }
    }
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      method:   'POST',
      timeout:  GEMINI_TTS_TIMEOUT,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-goog-api-key': GEMINI_API_KEY }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          const inline = JSON.parse(data).candidates[0].content.parts[0].inlineData;
          const rate   = parseInt((inline.mimeType.match(/rate=(\d+)/) || [])[1] || '24000');
          fs.writeFileSync(filepath, wavDePcm(Buffer.from(inline.data, 'base64'), rate));
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${GEMINI_TTS_TIMEOUT}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

function ttsPiper(message, filepath) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = execFile(PIPER_BIN, ['-m', PIPER_MODEL, '--length-scale', PIPER_LENGTH_SCALE, '-f', filepath],
      { timeout: 30000 }, (err, stdout, stderr) => err ? reject(new Error(stderr.trim() || err.message)) : resolve());
    child.stdin.end(message);
  });
}

async function generateTts(message) {
  const filename = `notifier_tts_${Date.now()}.wav`;
  const filepath = path.join(os.tmpdir(), filename);
  try {
    await ttsGemini(message, filepath);
    log(`tts: gemini ${GEMINI_TTS_VOICE}`);
  } catch (err) {
    log(`tts: gemini falló (${err.message}) → piper`);
    await ttsPiper(message, filepath);
    log(`tts: piper ${path.basename(PIPER_MODEL)} length_scale=${PIPER_LENGTH_SCALE}`);
  }
  return { filename, filepath };
}

// flock -n sale con 10 (-E) solo si el candado está tomado; cualquier otra falla cuenta como que no.
function lucesSiguenMusica() {
  if (!fs.existsSync(LUCES_MUSICA_LOCK)) return Promise.resolve(false);
  const { execFile } = require('child_process');
  return new Promise(resolve => {
    execFile('flock', ['-n', '-E', '10', LUCES_MUSICA_LOCK, 'true'], { timeout: 3000 }, err => {
      if (err && err.code !== 10) log(`lights: no se pudo consultar luces-musica (${err.message})`);
      resolve(!!err && err.code === 10);
    });
  });
}

// Con luces-musica prendido un pulso no se distingue de la música: el aviso va por Telegram,
// salvo que ya vaya por ahí (yaVaPorTelegram).
async function sendLights(priority, enviarTelegram, yaVaPorTelegram) {
  if (await lucesSiguenMusica()) {
    if (yaVaPorTelegram()) return log('lights: las luces siguen la música y el aviso ya va por telegram → nada');
    log('lights: las luces siguen la música → telegram');
    return enviarTelegram();
  }
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
    // Con volumen, el script espera el fin del aviso para devolver el volumen anterior.
    const env = { ...process.env, VOZ_VOLUMEN: GOOGLE_HOME_VOLUMEN };
    exec(`python3 "${scriptPath}" "${audioUrl}"${deviceArg}`, { timeout: 120000, env }, (err, stdout, stderr) => {
      if (stdout) stdout.trim().split('\n').forEach(l => log(`cast: ${l}`));
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });

  setTimeout(() => { try { fs.unlinkSync(filepath); } catch {} }, 30000);
}

// ── WiiM ──────────────────────────────────────────────────────────────────────
// setPlayerCmd:play corta lo que esté sonando y no lo retoma. Por eso, si el WiiM está
// tocando música, el aviso va al Google Home en su lugar. playPromptUrl (que baja la música
// y la retoma) se probó el 2026-09-26 y no suena ni con el WiiM parado ni con música por Cast.
function wiimCmd(command) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname:           WIIM_HOST,
      path:               `/httpapi.asp?command=${command}`,
      rejectUnauthorized: false,   // el WiiM usa un certificado autofirmado
      timeout:            10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data.trim()));
    });
    req.on('timeout', () => req.destroy(new Error('WiiM: timeout 10000ms')));
    req.on('error', reject);
  });
}

// Agrega `ms` de silencio al final de un WAV PCM y corrige los tamaños del encabezado.
// Recorre los chunks (Piper y Gemini no escriben el mismo encabezado) y exige que `data` sea el último.
function rellenarWav(buf, ms) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('no es WAV');
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { rate: buf.readUInt32LE(off + 12), blockAlign: buf.readUInt16LE(off + 20) };
    if (id === 'data') {
      if (!fmt) throw new Error('WAV sin fmt antes de data');
      if (off + 8 + size !== buf.length) throw new Error('el chunk data no es el último');
      const silencio = Buffer.alloc(Math.round(fmt.rate * ms / 1000) * fmt.blockAlign);
      const out = Buffer.concat([buf, silencio]);
      out.writeUInt32LE(size + silencio.length, off + 4);
      out.writeUInt32LE(out.length - 8, 4);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV sin chunk data');
}

async function wiimPlay(url) {
  const r = await wiimCmd(`setPlayerCmd:play:${url}`);
  if (r !== 'OK') throw new Error(`WiiM respondió: ${r.slice(0, 100)}`);
}

async function wiimEstado() {
  return JSON.parse(await wiimCmd('getPlayerStatus'));
}

// Espera a que termine lo que se mandó a sonar (tope: maxMs).
async function wiimEsperarFin(maxMs) {
  const inicio = Date.now();
  const pausa  = ms => new Promise(r => setTimeout(r, ms));
  await pausa(800);
  while (Date.now() - inicio < maxMs) {
    const { status } = await wiimEstado();
    if (status !== 'play' && status !== 'load') return;
    await pausa(300);
  }
}

// Saca el mute y fija WIIM_VOLUMEN. Devuelve lo que había, para wiimDevolverVolumen.
async function wiimFijarVolumen(estado) {
  const vol = parseInt(WIIM_VOLUMEN, 10);
  if (!(vol > 0 && vol <= 100)) throw new Error(`WIIM_VOLUMEN fuera de rango (1-100): ${WIIM_VOLUMEN}`);
  const previo = { vol: estado.vol, mute: estado.mute };
  if (previo.mute !== '0') await wiimCmd('setPlayerCmd:mute:0');
  await wiimCmd(`setPlayerCmd:vol:${vol}`);
  log(`wiim: volumen ${previo.vol}${previo.mute !== '0' ? ' mute' : ''} → ${vol}`);
  return previo;
}

async function wiimDevolverVolumen({ vol, mute }) {
  try {
    await wiimCmd(`setPlayerCmd:vol:${vol}`);
    if (mute !== '0') await wiimCmd('setPlayerCmd:mute:1');
    log(`wiim: volumen devuelto a ${vol}${mute !== '0' ? ' mute' : ''}`);
  } catch (err) {
    log(`wiim: no se pudo devolver el volumen (${err.message})`);
  }
}

async function sendWiim(message) {
  // 'CustomPushUrl' es un aviso anterior del propio notifier, no música del usuario.
  const estado = await wiimEstado();
  if (estado.status === 'play' && estado.vendor !== 'CustomPushUrl') {
    log(`wiim: tocando música (${estado.vendor || 'sin fuente'}) → google_home`);
    return sendGoogleHome(message);
  }
  const { filename, filepath } = await generateTts(message);
  try {
    fs.writeFileSync(filepath, rellenarWav(fs.readFileSync(filepath), WIIM_RELLENO_MS));
  } catch (err) {
    log(`wiim: no se pudo agregar silencio al final (${err.message}); puede cortarse la última palabra`);
  }
  const base = `http://${getLocalIp()}:${TTS_PORT}`;
  log(`TTS url: ${base}/${filename}`);
  const previo = WIIM_VOLUMEN ? await wiimFijarVolumen(estado) : null;
  try {
    if (fs.existsSync(WIIM_CHIME)) {
      await wiimPlay(`${base}/${path.basename(WIIM_CHIME)}`);
      await wiimEsperarFin(8000);
    } else {
      log(`wiim: sin chime (no existe ${WIIM_CHIME})`);
    }
    await wiimPlay(`${base}/${filename}`);
    log(`wiim: ok ${WIIM_HOST}`);
    if (previo) await wiimEsperarFin(60000);
  } finally {
    if (previo) await wiimDevolverVolumen(previo);
  }
  // El WiiM puede leer el archivo de a poco mientras suena: se borra más tarde que en Google Home.
  setTimeout(() => { try { fs.unlinkSync(filepath); } catch {} }, 5 * 60 * 1000);
}

// ── Queue cleanup ─────────────────────────────────────────────────────────────
function purgeOldRecords(db) {
  const { changes } = db.prepare(`
    DELETE FROM queue
    WHERE status IN ('sent', 'failed', 'skipped', 'expired')
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
    WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(BATCH_SIZE);

  for (const row of rows) {
    if (isInDnd(row.channel)) {
      db.prepare(`UPDATE queue SET status='skipped', sent_at=datetime('now') WHERE id=?`).run(row.id);
      log(`dnd: skipped id=${row.id} channel=${row.channel} (DND ${DND_START}-${DND_END}h)`);
      continue;
    }
    // Encolado y nunca intentado a tiempo (p. ej. el notifier estuvo parado): mismo vencimiento que un reintento.
    if (vencido(row)) {
      db.prepare(`UPDATE queue SET status='expired', next_attempt_at=NULL,
                  last_error=coalesce(last_error, 'vencido antes del primer intento') WHERE id=?`).run(row.id);
      log(`vencido id=${row.id} channel=${row.channel} source=${row.source} creado=${fmtTime(row.created_at)} — no se manda`);
      continue;
    }
    try {
      const ts   = fmtTime(row.created_at);
      const tags = etiquetas(row.source);
      const tarde = atrasado(row);
      const telegram = () => sendTelegram(`[${ts}] ${tarde ? '⏰ atrasado ' : ''}${prefijarTexto(row.message, tags, { html: true })}`,
                                          !!(row.silent || isDndTime()));
      const voz = () => (tarde ? `Aviso atrasado, de las ${ts.slice(6)}. ` : '') + prefijarVoz(row.message, tags);
      if (row.channel === 'telegram')    await telegram();
      if (row.channel === 'google_home') await sendGoogleHome(voz());
      if (row.channel === 'wiim')        await sendWiim(voz());
      if (row.channel === 'lights')      await sendLights(row.priority, telegram, () => !!db.prepare(`
        SELECT 1 FROM queue WHERE channel = 'telegram' AND source = ? AND message = ?
          AND abs(strftime('%s', created_at) - strftime('%s', ?)) <= ? LIMIT 1
      `).get(row.source, row.message, row.created_at, MISMO_AVISO_S));
      if (row.channel === 'email')       await sendEmail(row.email_to,
        (tarde ? '[atrasado] ' : '') + prefijarTexto(row.email_subject || '(sin asunto)', tags),
        tarde ? `Encolado el ${ts}, entregado con atraso.\n\n${row.message}` : row.message);
      db.prepare(`UPDATE queue SET status='sent', sent_at=datetime('now') WHERE id=?`).run(row.id);
      log(`sent id=${row.id} channel=${row.channel} silent=${row.silent} source=${tags.proceso}${tags.esPrueba ? ' PRUEBA' : ''}${tarde ? ` atrasado creado=${ts}` : ''}`);
      // Coreografía: si el evento pide análisis, disparar el hook recién ahora
      // (status='sent' garantiza que el incidente ya se entregó antes del análisis).
      if (row.analyze) fireAnalyzeHook(row.id);
    } catch (err) {
      const t = trasFalla(row, err);
      db.prepare(`UPDATE queue SET retries=?, status=?, next_attempt_at=?, last_error=? WHERE id=?`)
        .run(t.retries, t.status, t.next_attempt_at, String(err.message).slice(0, 300), row.id);
      const sigue = t.status === 'pending' ? `próximo intento ${t.next_attempt_at} UTC` : `(${t.motivo})`;
      log(`error id=${row.id} retries=${t.retries} status=${t.status} ${sigue} — ${err.message}`);
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
  log(`iniciado | db=${DB_PATH} | poll=${POLL_INTERVAL}ms | max_retries=${MAX_RETRIES} (permanentes) | reintento=${REINTENTO_BASE_S}-${REINTENTO_MAX_S}s | vence=${VENCIMIENTO_TEXTO_H}h texto, ${VENCIMIENTO_AL_OIDO_MIN}min voz/luces | tts_ip=${getLocalIp()} | retention=${QUEUE_RETENTION_DAYS}d`);

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

// Exportado solo para los tests (test_etiquetas.js, test_wav.js, test_reintentos.js).
module.exports = { etiquetas, prefijarTexto, prefijarVoz, yaEtiquetado, generateTts, rellenarWav, wavDePcm,
                   esperaS, vencido, atrasado, trasFalla, processBatch, initDb };
