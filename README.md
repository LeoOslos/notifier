# Notifier

Servicio centralizado de notificaciones con cola persistente SQLite. Corre como proceso PM2 y soporta cuatro canales: Telegram, Google Home (TTS por Cast), Email (Gmail SMTP) y Lights (LIFX via HA).

## Arquitectura

```
Script Python / CLI
       │
       ▼
   queue.db (SQLite)
       │
       ▼
  notifier.js (PM2, poll cada 2s)
       ├── telegram    → API Bot de Telegram
       ├── google_home → cast_google_home.py → pychromecast → Google Home / Nest Hub / Chromecast
       ├── email       → Gmail SMTP (nodemailer) → casilla destino configurable por mensaje
       └── lights      → cast_lights.py → Home Assistant API → luces LIFX
```

El notifier hace polling a la DB cada 2 segundos. Los mensajes se encolan desde cualquier script y se procesan en orden de prioridad.

---

## Instalación y arranque

```bash
cd ~/notifier
npm install
cp .env.example .env   # completar tokens
pm2 start ecosystem.config.js
pm2 save
```

### Requisitos Python (Google Home)
```bash
pip install pychromecast
# Voz de respaldo (Piper, local): venv propio + modelo de voz (114 MB, fuera de Git)
python3 -m venv piper-venv && piper-venv/bin/pip install -r requirements-piper.txt
mkdir -p voces && for f in es_AR-daniela-high.onnx es_AR-daniela-high.onnx.json; do
  curl -sfL -o voces/$f https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/daniela/high/$f; done
sudo ufw allow 9876/tcp   # el Mini necesita descargar el MP3 desde esta máquina
```

---

## Configuración (.env)

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Do Not Disturb
DND_START=23          # hora de inicio (formato 24h)
DND_END=8             # hora de fin
DND_CHANNELS=google_home,lights  # canales bloqueados (separados por coma)

# Opcionales
TTS_PORT=9876
GEMINI_API_KEY=...            # voz principal (Gemini TTS). Sin clave → siempre Piper
PIPER_LENGTH_SCALE=1.5        # velocidad de la voz de respaldo (>1 = más lenta)
GOOGLE_HOME_DEVICE=Mini       # substring del nombre del dispositivo. Vacío = todos.
POLL_INTERVAL=2000
MAX_RETRIES=3
BATCH_SIZE=10

# Email (canal email)
GMAIL_USER=cuenta@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   # App Password de Google, no la contraseña normal

# Home Assistant (canal lights)
HA_URL=http://localhost:8123
HA_TOKEN=...
```

Después de editar `.env`: `pm2 restart ecosystem.config.js --update-env`

---

## Uso

### Desde Python

```python
from client import notify

notify("El script terminó")                              # telegram, silencioso
notify("Precio en target", silent=False)                 # telegram con sonido (si no es DND)
notify("Alerta crítica", priority=1)                     # telegram, prioridad alta, silencioso
notify("Proceso finalizado", channel="google_home")      # habla en todos los parlantes
notify("HA caído", priority=1, analyze=True, source="chequeo_ha")  # análisis + origen
notify(                                                              # email
    "El cierre falló en el paso IOL.",
    channel="email",
    email_to="destino@gmail.com",
    email_subject="[cedears] Error en cierre diario",
    source="cedears",
)
```

El parámetro `source` identifica qué proceso encoló la notificación. Viaja en la fila
para que el **analyzer** sepa el origen del incidente, y **el notifier lo estampa en lo
que se entrega**: `[proceso]` adelante del texto de Telegram y del asunto del mail, y
«Aviso de <proceso>» dicho en palabras por el parlante. Si no se pasa, se deriva del
script en ejecución — nunca queda en `'unknown'` por olvido.

Un mensaje ya etiquetado por el llamador no se etiqueta dos veces: vale el proceso
completo o su última parte (`[piso_jubilacion]` cuenta para `finanzas-cuenta/piso_jubilacion`).

### Pruebas: `prueba=True`

```python
notify("Probando el canal", prueba=True)                  # source → '<script>/prueba'
notify("Probando", channel="google_home", source="vencimientos", prueba=True)
```

Marca el `source` con el sufijo `/prueba` y el notifier hace el resto: `[PRUEBA]` al
principio del texto y del asunto, y por el parlante *«Atención, esto es una prueba, no es
un aviso real»* —el TTS lee el texto, así que un corchete sonaría mal—. Es la regla de
CLAUDE.md, y está acá y no en cada llamador a propósito: el tag no puede depender de que
alguien se acuerde de ponerlo.

### Desde CLI

```bash
node enqueue.js "mensaje"                        # telegram, silencioso
node enqueue.js "mensaje" telegram 1 0           # telegram, prioridad 1, con sonido
node enqueue.js "mensaje" google_home            # Google Home
# args: "mensaje" [canal] [prioridad] [silent] [analyze] [source]
node enqueue.js "Probando" telegram 5 1 0 vencimientos/prueba   # sale marcado [PRUEBA]
node enqueue.js "HA caído" telegram 1 0 1 chequeo_ha   # análisis autónomo + origen
# args email: "mensaje" email [prioridad] [silent] [analyze] [source] email_to email_subject
node enqueue.js "El cierre falló." email 5 1 0 cedears "dest@gmail.com" "[cedears] Error cierre"
```

## Formato de los mensajes entregados

El timestamp se agrega automáticamente al momento de enviar, reflejando cuándo ocurrió el evento (no cuándo se entregó — puede diferir si hubo DND).

Todo mensaje entregado dice **qué proceso lo encoló** (campo `source`), y si es una
prueba lo dice también. Lo estampa el notifier al enviar, no el llamador.

- **Telegram:** `[18/05 22:08] [cedears/pf-vencido] El script terminó`
- **Google Home:** `Aviso de cedears pf vencido. El script terminó` — sin prefijo de hora.
- **Email:** From fijo `notifier <GMAIL_USER>`; asunto `[cedears/pf-vencido] Asunto del caller`.
- **Prueba** (`source` terminado en `/prueba`): `[PRUEBA]` delante del texto y del asunto;
  por el parlante, *«Atención, esto es una prueba, no es un aviso real»*.

---

## Canales

### lights

Notificaciones visuales via luces LIFX a través de la API de Home Assistant. No convierte el mensaje en texto — solo usa el canal y la prioridad.

**Modos según prioridad:**

| Prioridad | Modo | Efecto |
|-----------|------|--------|
| 1 | `alert` | 3 blinks rojos, 50% brillo, 0.3s — algo urgente |
| 2–4 | `pulse` | Breathe rojo suave, 25% brillo, 0.35s — notificación normal |
| 5+ | `info` | Breathe azul, 15% brillo, 1.2s — bajo impacto |

La prioridad controla tanto el **orden de despacho** (menor número = sale antes) como el **efecto visual**. Dentro de cada rango, todos los valores producen el mismo efecto.

Aplica a todas las luces LIFX de la casa:
- Luces con soporte de color: cambian al color del modo
- Luces solo blancas (`bathroom_lamp`, `shelf_lamp`): pulsan en brillo sin cambio de color

En DND: se skipea igual que `google_home`.

**Configuración requerida en `.env`:**
```env
HA_URL=http://localhost:8123
HA_TOKEN=<long-lived access token de Home Assistant>
```

### telegram
- Siempre envía, nunca bloqueado por DND.
- Por defecto silencioso (`disable_notification: true`).
- `silent=0`: envía con sonido, excepto si está en horario DND → fuerza silencioso.

### google_home
- Genera la voz con **Gemini TTS** (voz `Kore`, modelo `gemini-2.5-flash-preview-tts`).
  Si Gemini falla por cualquier motivo (sin internet, cuota, error de API, timeout de 30 s),
  cae a **Piper** local (`es_AR-daniela-high`, `length_scale` 1.5 = más lenta). El log dice
  cuál habló: `tts: gemini Kore` o `tts: gemini falló (...) → piper`.
- Antes de la voz suena un chime: es del propio Google Home al abrir la sesión de Cast
  (probado casteando un audio inexistente: suena igual). No sale del notifier.
- Sirve el WAV por HTTP desde `wlo1` (IP WiFi: 192.168.0.100), puerto 9876.
- Castea al dispositivo cuyo nombre contenga `GOOGLE_HOME_DEVICE` (substring, case-insensitive). Si está vacío, castea a todos.
- En DND: se marca `skipped` inmediatamente, nunca se entrega.

Otras voces de Gemini: `GEMINI_TTS_VOICE` (Charon, Puck, …). Otro modelo de Piper: `PIPER_MODEL`.

### email
- Envía via Gmail SMTP (nodemailer). Requiere `GMAIL_USER` y `GMAIL_APP_PASSWORD` en `.env`.
- From fijo: `"notifier" <GMAIL_USER>`. El proceso que invoca se identifica en el subject,
  estampado por el notifier a partir de `source` (el caller ya no necesita prefijarlo a mano).
- Destinatario (`email_to`) y asunto (`email_subject`) definidos por el caller en cada mensaje.
- Valida formato de `email_to` antes de encolar (requiere `@` y dominio con `.`).
- **Nunca bloqueado por DND** — siempre entrega.
- Texto plano únicamente.

**Credenciales:** usar un App Password de Google (no la contraseña normal de la cuenta). Generarlo en `myaccount.google.com → Seguridad → Contraseñas de aplicaciones`.

---

## Tests

```bash
node test_etiquetas.js     # etiquetado de origen y de prueba en la salida
python3 test_client.py     # el origen que se guarda al encolar
```

No tocan la cola de producción: el primero importa `notifier.js` sin arrancar el daemon
(`require.main`), el segundo usa una base temporal.

---

## Do Not Disturb

| Situación | google_home | telegram silent=1 | telegram silent=0 | email |
|-----------|-------------|-------------------|-------------------|-------|
| Fuera de DND | envía | silencioso | con sonido | envía |
| En DND (23-8h) | **skipped** | silencioso | silencioso | envía |

`google_home` en DND se marca `skipped` inmediatamente — no se entrega nunca, queda como evidencia en la cola. No hay catarata de mensajes al salir del DND.

## Un aviso que no se pudo entregar no se entrega después

`MAX_RETRIES=3` reintentos con `POLL_INTERVAL` de por medio y, si no salió, el aviso queda
`failed` en la cola **para siempre**: nadie lo reencola cuando la red vuelve. Es el
comportamiento buscado, por la misma razón que el `skipped` del DND — **un aviso
describe el estado del momento en que se encoló, y entregarlo tarde informa mal**.

El caso que lo muestra es el corte de luz del 2026-09-22 (INC-2026-036), que dejó cuatro
avisos en `failed` con `getaddrinfo ENOTFOUND api.telegram.org`: «corte de luz detectado»,
«WAN caída», «eno1 sin ruta al gateway — requiere intervención manual» y «la sincronización
de memoria viene fallando». Tres horas después los cuatro eran falsos, y el peor —el de
`eno1`— habría mandado a intervenir a mano sobre algo que se resolvió solo al volver la luz.
Lo que sí corresponde avisar cuando el servicio vuelve es **que volvió**, y de eso se encarga
el aviso de recuperación de `power-monitor` (y el de arranque de `boot-notify.sh`), que se
encolan con la red ya disponible.

Consecuencia para el que llama: **si un aviso tiene que sobrevivir a una caída de red, la
cola del notifier no es el lugar.** Eso es estado, y va a un archivo o a una base que el
proceso relea al arrancar.

Los `failed` quedan en la cola como evidencia hasta que los borra la depuración
(`QUEUE_RETENTION_DAYS`); para verlos:

```bash
sqlite3 ~/notifier/queue.db "select id, created_at, source, substr(message,1,60) from queue where status='failed' order by id desc limit 10;"
```

Ojo con las horas: `created_at` se guarda en **UTC** y el log del servicio va en hora local
(-03), así que la misma entrega aparece con tres horas de diferencia según dónde se la mire.

## Depuración de la cola

Los registros con status `sent`, `failed` o `skipped` se eliminan automáticamente al arrancar el servicio y cada hora. Retención configurable en `.env`:

```env
QUEUE_RETENTION_DAYS=30
```

---

## Schema de la cola

```sql
CREATE TABLE queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT    NOT NULL DEFAULT 'telegram',
  message    TEXT    NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 5,   -- menor número = mayor prioridad
  silent     INTEGER NOT NULL DEFAULT 1,   -- 1=silencioso, 0=con sonido
  analyze    INTEGER NOT NULL DEFAULT 0,   -- 1=dispara hook de análisis al pasar a 'sent'
  source     TEXT    NOT NULL DEFAULT 'unknown',  -- qué proceso encoló: se estampa en la entrega
                                                 -- y da contexto al analyzer. Sufijo '/prueba' → [PRUEBA]
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  retries    INTEGER NOT NULL DEFAULT 0,
  email_to      TEXT NOT NULL DEFAULT '',  -- destinatario (solo canal email)
  email_subject TEXT NOT NULL DEFAULT '',  -- asunto (solo canal email)
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
```

---

## Red local — notas críticas

La máquina tiene dos interfaces:
- `eno1` → 192.168.0.101 (Ethernet)
- `wlo1` → 192.168.0.100 (WiFi)

Los Google Home están en WiFi y descargan el MP3 **desde la IP WiFi** (192.168.0.100). El servidor TTS debe estar accesible desde esa interfaz, y el puerto debe estar abierto en UFW:

```bash
sudo ufw allow 9876/tcp
```

El control Cast (pychromecast → dispositivo) funciona desde cualquier IP. La restricción es el sentido inverso: el dispositivo bajando el audio.

HTTP local es suficiente — no se necesita HTTPS.

---

## Dispositivos en la red

| Nombre | IP | Tipo |
|--------|----|------|
| Mini | 192.168.0.122 | Google Home Mini |
| Mini (2) | 192.168.0.53 | Google Home Mini |
| Hub | 192.168.0.134 | Google Nest Hub |
| The TV | 192.168.0.106 | Chromecast |

---

## Logs

```bash
pm2 logs notifier --lines 50
```

Entradas relevantes:
- `sent id=N channel=X silent=Y` — mensaje enviado
- `dnd: skipped id=N` — en horario DND, descartado (no se reintenta)
- `cast: ok NombreDispositivo` — Cast exitoso
- `cast: error NombreDispositivo: ...` — falló ese dispositivo (otros pueden haber funcionado)
- `error id=N retries=M status=failed` — agotó reintentos
