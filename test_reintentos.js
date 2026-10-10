#!/usr/bin/env node
'use strict';
// Tests de reintentos y vencimiento (BL-279). Se corren con: node test_reintentos.js
// Sin red el aviso no se descarta: queda pendiente con espera creciente hasta que vence.
// El último caso corre processBatch de verdad en un proceso hijo sin red (el DNS falla con
// EAI_AGAIN, como en un corte) contra una cola temporal: no toca queue.db ni manda nada.
// No usa `unshare -rn`: Ubuntu 24.04 restringe los user namespaces sin privilegios.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

// Corrida hija: sin red. Encola, procesa y devuelve la fila.
if (process.env.TEST_SIN_RED_DB) {
  process.env.DB_PATH = process.env.TEST_SIN_RED_DB;
  require('dns').lookup = (host, opts, cb) => {
    const err = Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' });
    process.nextTick(cb || opts, err);
  };
  const { initDb, processBatch } = require('./notifier.js');
  const db = initDb();
  db.prepare(`INSERT INTO queue (channel, message, source) VALUES ('telegram', 'test', 'test_reintentos/prueba')`).run();
  processBatch(db).then(() => {
    process.stdout.write('\nFILA ' + JSON.stringify(db.prepare('SELECT * FROM queue').get()));
    db.close();
  });
  return;
}

const { esperaS, vencido, atrasado, trasFalla } = require('./notifier.js');

const casos = [];
const test = (nombre, fn) => casos.push([nombre, fn]);

const ahora  = new Date('2026-10-10T12:00:00Z');
const hace   = min => new Date(ahora.getTime() - min * 60e3).toISOString().slice(0, 19).replace('T', ' ');
const fila   = (channel, minAtras, retries = 0) => ({ channel, created_at: hace(minAtras), retries });
const red    = Object.assign(new Error('getaddrinfo EAI_AGAIN api.telegram.org'), { code: 'EAI_AGAIN' });
const perm   = Object.assign(new Error('Telegram: Bad Request (400)'), { permanente: true });

test('espera creciente: 30 s, 60 s, 120 s… con tope de 15 min', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 10].map(esperaS), [30, 60, 120, 240, 480, 900, 900]);
});

test('sin red, telegram sigue pendiente aunque pase MAX_RETRIES', () => {
  const t = trasFalla(fila('telegram', 60, 7), red, ahora);
  assert.strictEqual(t.status, 'pending');
  assert.strictEqual(t.retries, 8);
  assert.strictEqual(t.next_attempt_at, '2026-10-10 12:15:00');
});

test('sin red, telegram vence a las 3 h', () => {
  assert.strictEqual(trasFalla(fila('telegram', 2 * 60), red, ahora).status, 'pending');
  const t = trasFalla(fila('telegram', 3 * 60 - 0.1), red, ahora);
  assert.deepStrictEqual([t.status, t.motivo], ['failed', 'vencido']);
});

test('voz y luces vencen a los 30 min', () => {
  for (const c of ['google_home', 'wiim', 'lights']) {
    assert.strictEqual(trasFalla(fila(c, 5), red, ahora).status, 'pending', c);
    assert.strictEqual(trasFalla(fila(c, 29.9, 3), red, ahora).status, 'failed', c);
  }
});

test('falla permanente: corta en MAX_RETRIES (3) como antes', () => {
  assert.strictEqual(trasFalla(fila('telegram', 1, 1), perm, ahora).status, 'pending');
  const t = trasFalla(fila('telegram', 1, 2), perm, ahora);
  assert.deepStrictEqual([t.status, t.motivo], ['failed', 'permanente']);
});

test('vencido y atrasado por canal', () => {
  assert.strictEqual(vencido(fila('telegram', 2.9 * 60), ahora), false);
  assert.strictEqual(vencido(fila('telegram', 3.1 * 60), ahora), true);
  assert.strictEqual(vencido(fila('wiim', 31), ahora), true);
  assert.strictEqual(atrasado(fila('telegram', 9), ahora), false);
  assert.strictEqual(atrasado(fila('telegram', 11), ahora), true);
});

test('processBatch sin red: la fila queda pendiente con próximo intento, no failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-test-'));
  try {
    const salida = execFileSync(process.execPath, [__filename], {
      env: { ...process.env, TEST_SIN_RED_DB: path.join(dir, 'queue.db') }, timeout: 30000
    }).toString();
    // El log del notifier también sale por stdout: la fila va en la última línea.
    const row = JSON.parse(salida.split('\nFILA ').pop());
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.retries, 1);
    assert.ok(row.next_attempt_at, 'sin next_attempt_at');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let fallas = 0;
for (const [nombre, fn] of casos) {
  try { fn(); console.log(`ok   ${nombre}`); }
  catch (err) { fallas++; console.log(`FAIL ${nombre}\n     ${err.message}`); }
}
console.log(`\n${casos.length - fallas}/${casos.length} ok`);
process.exit(fallas ? 1 : 0);
