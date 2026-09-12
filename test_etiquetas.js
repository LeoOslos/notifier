#!/usr/bin/env node
'use strict';
// Tests del etiquetado de origen. Se corren con: node test_etiquetas.js
// Cubren la regla de CLAUDE.md: toda notificación dice qué proceso la encoló, y
// una prueba se anuncia como prueba en los tres canales de texto y en el parlante.

const assert = require('assert');
const { etiquetas, prefijarTexto, prefijarVoz, yaEtiquetado } = require('./notifier.js');

const casos = [];
const test = (nombre, fn) => casos.push([nombre, fn]);

test('source simple: proceso tal cual, no es prueba', () => {
  assert.deepStrictEqual(etiquetas('cedears/pf-vencido'), { proceso: 'cedears/pf-vencido', esPrueba: false });
});

test('sufijo /prueba: lo saca del proceso y marca la prueba', () => {
  assert.deepStrictEqual(etiquetas('cedears/pf-vencido/prueba'), { proceso: 'cedears/pf-vencido', esPrueba: true });
});

test('source vacío o unknown cae en "desconocido", nunca en nada', () => {
  for (const v of ['', '   ', null, undefined, 'unknown', 'UNKNOWN']) {
    assert.strictEqual(etiquetas(v).proceso, 'desconocido', `source=${JSON.stringify(v)}`);
  }
});

test('solo "/prueba" como source: prueba de proceso desconocido', () => {
  assert.deepStrictEqual(etiquetas('/prueba'), { proceso: 'desconocido', esPrueba: true });
});

test('texto sin tag: se le estampa el proceso adelante', () => {
  assert.strictEqual(prefijarTexto('El fondo cayó', etiquetas('finanzas-cuenta/piso_jubilacion')),
                     '[finanzas-cuenta/piso_jubilacion] El fondo cayó');
});

test('el llamador ya puso la hoja del proceso: no se duplica', () => {
  const t = '[piso_jubilacion] El fondo cayó';
  assert.strictEqual(prefijarTexto(t, etiquetas('finanzas-cuenta/piso_jubilacion')), t);
});

test('tag ajeno adelante: igual se estampa el proceso real', () => {
  assert.strictEqual(prefijarTexto('[otro] Aviso', etiquetas('cedears/atribucion')),
                     '[cedears/atribucion] [otro] Aviso');
});

test('prueba: [PRUEBA] primero y el proceso después', () => {
  assert.strictEqual(prefijarTexto('Probando canal', etiquetas('vencimientos/prueba')),
                     '[PRUEBA] [vencimientos] Probando canal');
});

test('idempotente: pasar dos veces no agrega tags', () => {
  const tags = etiquetas('vencimientos/prueba');
  const una  = prefijarTexto('Probando', tags);
  assert.strictEqual(prefijarTexto(una, tags), una);
});

test('HTML de Telegram: el proceso se escapa, no rompe el parse_mode', () => {
  assert.strictEqual(prefijarTexto('hola', etiquetas('a<b>c'), { html: true }), '[a&lt;b&gt;c] hola');
});

test('parlante: dice la prueba en palabras y nombra el proceso sin corchetes', () => {
  const voz = prefijarVoz('El fondo cayó', etiquetas('finanzas-cuenta/piso_jubilacion/prueba'));
  assert.strictEqual(voz, 'Atención, esto es una prueba, no es un aviso real. Aviso de finanzas cuenta piso jubilacion. El fondo cayó');
  assert.ok(!/[[\]/_]/.test(voz.replace('El fondo cayó', '')), 'el TTS no debe leer corchetes ni barras');
});

test('parlante sin prueba: solo el aviso de origen', () => {
  assert.strictEqual(prefijarVoz('Llegó el pedido', etiquetas('seguimiento-envios')),
                     'Aviso de seguimiento envios. Llegó el pedido');
});

test('yaEtiquetado reconoce proceso completo y hoja, no un tag cualquiera', () => {
  assert.ok(yaEtiquetado('[cedears/atribucion] x', 'cedears/atribucion'));
  assert.ok(yaEtiquetado('[atribucion] x', 'cedears/atribucion'));
  assert.ok(!yaEtiquetado('[PRUEBA] x', 'cedears/atribucion'));
  assert.ok(!yaEtiquetado('sin tag', 'cedears/atribucion'));
});

let fallas = 0;
for (const [nombre, fn] of casos) {
  try { fn(); console.log(`  ok   ${nombre}`); }
  catch (err) { fallas++; console.log(`  FALLA ${nombre}\n        ${err.message}`); }
}
console.log(`\n${casos.length - fallas}/${casos.length} pasaron`);
process.exit(fallas ? 1 : 0);
