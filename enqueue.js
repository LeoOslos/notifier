#!/usr/bin/env node
'use strict';

// Uso: node enqueue.js "mensaje" [canal] [prioridad] [silent] [analyze] [source] [email_to] [email_subject]
// Ejemplos:
//   node enqueue.js "Se fue la luz"
//   node enqueue.js "Precio en target" telegram 1 0   ← con sonido (si no es DND)
//   node enqueue.js "Audio" google_home
//   node enqueue.js "HA caído" telegram 1 0 1         ← marcado para análisis autónomo
//   node enqueue.js "HA caído" telegram 1 0 1 chequeo_ha   ← + origen para el analyzer
//   node enqueue.js "Alerta" email 5 1 0 unknown dest@gmail.com "Asunto del mail"

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'queue.db');

function isValidEmail(addr) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function enqueue(message, channel = 'telegram', priority = 5, silent = 1, analyze = 0, source = 'unknown', emailTo = '', emailSubject = '') {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO queue (channel, message, priority, silent, analyze, source, email_to, email_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(channel, message, priority, silent, analyze, source, emailTo, emailSubject);
  db.close();
  return lastInsertRowid;
}

const [,, message, channel = 'telegram', priority = '5', silent = '1', analyze = '0', source = 'unknown', emailTo = '', emailSubject = ''] = process.argv;

if (!message) {
  console.error('Uso: node enqueue.js "mensaje" [canal] [prioridad] [silent] [analyze] [source] [email_to] [email_subject]');
  process.exit(1);
}

if (channel === 'email' && !isValidEmail(emailTo)) {
  console.error(`Error: canal email requiere email_to válido (tiene arroba y dominio). Recibido: "${emailTo}"`);
  process.exit(1);
}

try {
  const id = enqueue(message, channel, parseInt(priority), parseInt(silent), parseInt(analyze), source, emailTo, emailSubject);
  console.log(`queued id=${id} channel=${channel} priority=${priority} silent=${silent} analyze=${analyze} source=${source} email_to=${emailTo}`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
