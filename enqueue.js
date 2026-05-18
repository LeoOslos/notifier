#!/usr/bin/env node
'use strict';

// Uso: node enqueue.js "mensaje" [canal] [prioridad]
// Ejemplos:
//   node enqueue.js "Se fue la luz"
//   node enqueue.js "Alerta crítica" telegram 1
//   echo "mensaje" | node enqueue.js

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'queue.db');

function enqueue(message, channel = 'telegram', priority = 5) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO queue (channel, message, priority) VALUES (?, ?, ?)`
  ).run(channel, message, priority);
  db.close();
  return lastInsertRowid;
}

const [,, message, channel = 'telegram', priority = '5'] = process.argv;

if (!message) {
  console.error('Uso: node enqueue.js "mensaje" [canal] [prioridad]');
  process.exit(1);
}

try {
  const id = enqueue(message, channel, parseInt(priority));
  console.log(`queued id=${id} channel=${channel} priority=${priority}`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
