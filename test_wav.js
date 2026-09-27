#!/usr/bin/env node
'use strict';
// Tests del relleno de silencio para el WiiM (BL-216). Se corren con: node test_wav.js

const assert = require('assert');
const { rellenarWav, wavDePcm } = require('./notifier.js');

const casos = [];
const test = (nombre, fn) => casos.push([nombre, fn]);

test('agrega el silencio pedido y corrige los dos tamaños del encabezado', () => {
  const pcm = Buffer.alloc(24000 * 2, 7);                 // 1 s a 24 kHz, 16 bit mono
  const out = rellenarWav(wavDePcm(pcm, 24000), 1500);
  assert.strictEqual(out.length, 44 + pcm.length + 36000 * 2);
  assert.strictEqual(out.readUInt32LE(4), out.length - 8);
  assert.strictEqual(out.readUInt32LE(40), pcm.length + 36000 * 2);
  assert.ok(out.subarray(44 + pcm.length).every(b => b === 0), 'la cola es silencio');
  assert.ok(out.subarray(44, 44 + pcm.length).equals(pcm), 'la voz queda intacta');
});

test('WAV con un chunk extra antes de data (como el de Piper con LIST)', () => {
  const base = wavDePcm(Buffer.alloc(100, 1), 22050);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
  const wav = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
  wav.writeUInt32LE(wav.length - 8, 4);
  const out = rellenarWav(wav, 100);
  const dataOff = 36 + list.length;
  assert.strictEqual(out.toString('ascii', dataOff, dataOff + 4), 'data');
  assert.strictEqual(out.readUInt32LE(dataOff + 4), 100 + 2205 * 2);
  assert.strictEqual(out.readUInt32LE(4), out.length - 8);
});

test('rechaza lo que no es WAV y un data que no es el último chunk', () => {
  assert.throws(() => rellenarWav(Buffer.from('no es un wav para nada, ni cerca'), 100), /no es WAV/);
  const wav = Buffer.concat([wavDePcm(Buffer.alloc(10), 24000), Buffer.from('basura')]);
  assert.throws(() => rellenarWav(wav, 100), /no es el último/);
});

let fallas = 0;
for (const [nombre, fn] of casos) {
  try { fn(); console.log(`ok   ${nombre}`); }
  catch (e) { fallas++; console.log(`FAIL ${nombre}\n     ${e.message}`); }
}
console.log(`${casos.length - fallas}/${casos.length} ok`);
process.exit(fallas ? 1 : 0);
