// registro_log.js — formato estándar de log para Node (plan: ~/planes/PLAN-estandarizar-logs.md, Fase 8).
//
// PLANTILLA, hermana de registro_log.py y registro_log.sh: se COPIA a cada proyecto (regla 6 de arquitectura:
// no se importa desde otro repo). Cambiar el formato es cambiar las tres plantillas, sus copias y logcron.py;
// test_registro_log_js.py verifica que la salida pase intacta por logcron.py.
//
// Uso:
//   const { crearLog } = require('./registro_log');
//   const log = crearLog('notifier');                          // a stdout (pm2 lo manda a su out_file)
//   const log = crearLog('power-monitor', { archivo: RUTA });  // además, a un archivo propio
//   log.info('listo'); log.warning('ojo'); log.error('falló', err);   // un Error sale con su stack
//
// Línea: 2026-09-14 21:00:00 -03 INFO notifier leoadmin mensaje
// Un mensaje de varias líneas lleva el prefijo en cada una. Con pm2, sacar `time`/`log_date_format` del
// ecosystem: si no, pm2 le antepone su propia fecha.
//
// Solo módulos de Node.
'use strict';

const fs = require('fs');
const os = require('os');

const PROCESO_VALIDO = /^[A-Za-z0-9_.-]+$/;
const FORMATO_FECHA = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// Buenos Aires no tiene horario de verano: el offset es siempre -03.
function fecha(d = new Date()) {
  return `${FORMATO_FECHA.format(d)} -03`;
}

function texto(partes) {
  return partes.map(p => (p instanceof Error ? (p.stack || String(p))
    : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
}

/**
 * @param {string} proceso  nombre del proceso, sin espacios
 * @param {{archivo?: string | null, salida?: {write: (s: string) => any}}} [opciones]
 */
function crearLog(proceso, { archivo = null, salida = process.stdout } = {}) {
  if (!PROCESO_VALIDO.test(proceso)) throw new Error(`proceso inválido para el log (sin espacios): ${proceso}`);
  const usuario = os.userInfo().username;

  const escribir = (nivel, partes) => {
    const prefijo = `${fecha()} ${nivel} ${proceso} ${usuario} `;
    const lineas = texto(partes).split(/\r?\n/).filter(l => l.trim());
    const bloque = (lineas.length ? lineas : ['']).map(l => prefijo + l).join('\n') + '\n';
    salida.write(bloque);
    if (archivo) {
      try {
        fs.appendFileSync(archivo, bloque);
      } catch (err) {
        salida.write(`${fecha()} ERROR ${proceso} ${usuario} no pude escribir el log ${archivo}: ${err.message}\n`);
      }
    }
  };

  return {
    debug: (...p) => escribir('DEBUG', p),
    info: (...p) => escribir('INFO', p),
    warning: (...p) => escribir('WARNING', p),
    error: (...p) => escribir('ERROR', p),
    critical: (...p) => escribir('CRITICAL', p),
  };
}

module.exports = { crearLog, fecha };
