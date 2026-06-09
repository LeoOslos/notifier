#!/usr/bin/env node
'use strict';

// Uso: node enqueue.js "mensaje" [canal] [prioridad] [silent] [analyze]
// Ejemplos:
//   node enqueue.js "Se fue la luz"
//   node enqueue.js "Precio en target" telegram 1 0   ← con sonido (si no es DND)
//   node enqueue.js "Audio" google_home
//   node enqueue.js "HA caído" telegram 1 0 1         ← marcado para análisis autónomo

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'queue.db');

function enqueue(message, channel = 'telegram', priority = 5, silent = 1, analyze = 0) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO queue (channel, message, priority, silent, analyze) VALUES (?, ?, ?, ?, ?)`
  ).run(channel, message, priority, silent, analyze);
  db.close();
  return lastInsertRowid;
}

const [,, message, channel = 'telegram', priority = '5', silent = '1', analyze = '0'] = process.argv;

if (!message) {
  console.error('Uso: node enqueue.js "mensaje" [canal] [prioridad] [silent] [analyze]');
  process.exit(1);
}

try {
  const id = enqueue(message, channel, parseInt(priority), parseInt(silent), parseInt(analyze));
  console.log(`queued id=${id} channel=${channel} priority=${priority} silent=${silent} analyze=${analyze}`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
