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
GOOGLE_HOME_VOLUMEN=0.5       # volumen de los avisos en Cast (0-1). Vacío = no tocarlo
WIIM_VOLUMEN=40               # volumen de los avisos en el WiiM (1-100). Vacío = no tocarlo
POLL_INTERVAL=2000
MAX_RETRIES=3                 # solo fallas permanentes; las de red se reintentan hasta vencer
REINTENTO_BASE_S=30           # espera creciente entre reintentos, de 30 s…
REINTENTO_MAX_S=900           # …hasta 15 min
VENCIMIENTO_TEXTO_H=3         # telegram/email sin entregar a las 3 h → failed
VENCIMIENTO_AL_OIDO_MIN=30    # google_home/wiim/lights: a los 30 min
ATRASO_MIN=10                 # desde cuánto atraso la entrega dice «atrasado»
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
notify("Proceso finalizado", channel="wiim")             # habla por el WiiM Amp
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
- Luces apagadas: se prenden para el efecto y al terminar se vuelven a apagar; las prendidas vuelven a su color previo (`power_on: true` de `lifx.effect_pulse`, lo restaura `aiolifx_effects`)
- Si las luces están siguiendo la música (luces-musica tiene tomado el `flock` de `~/luces-musica/datos/corriendo.lock`, `LUCES_MUSICA_LOCK`), el aviso va por **Telegram** en vez de las luces: un pulso no se distinguiría de la música. Si el mismo aviso ya va por Telegram (fila `telegram` con igual `source` y texto, encolada a menos de 60 s), no se repite

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

**Volumen (BL-237, `GOOGLE_HOME_VOLUMEN` / `WIIM_VOLUMEN`):** antes de cada aviso por voz se saca
el mute y se fija el volumen de aviso; al terminar de hablar se devuelve el volumen y el mute que
había. Así el aviso no sale mudo ni a todo volumen según cómo quedó el parlante. El log lo dice:
`cast: volumen Mini: 0.30 -> 0.50` … `cast: volumen Mini: devuelto a 0.30` (en el WiiM,
`wiim: volumen 23 → 40` … `wiim: volumen devuelto a 23`). Mientras habla, la cola espera (tope 60 s).

Otras voces de Gemini: `GEMINI_TTS_VOICE` (Charon, Puck, …). Otro modelo de Piper: `PIPER_MODEL`.

### wiim
- Misma voz que `google_home` (Kore, respaldo Piper), pero por el WiiM Amp (`WIIM_HOST`, default
  `192.168.1.147`) con su API HTTP: `setPlayerCmd:play:<url>`. Sin chime.
- **Si el WiiM está tocando música, el aviso va al Google Home** (`google_home`), porque
  `setPlayerCmd:play` cortaría la música sin retomarla. `playPromptUrl` (bajar la música y
  retomarla) se probó y no suena en este equipo, ni parado ni con música por Cast.
- **Si está parado:** suena el chime (`WIIM_CHIME`, default `sonidos/chime.mp3`) y después el aviso.
  El chime no está en Git (la licencia de Mixkit no permite redistribuirlo suelto); se baja con
  `mkdir -p sonidos && curl -sfL -o sonidos/chime.mp3 https://assets.mixkit.co/active_storage/sfx/914/914-preview.mp3`
  («Happy bells notification», Mixkit). Si falta, el aviso sale sin chime.
- **Silencio al final (`WIIM_RELLENO_MS`, default 1500):** el WiiM deja de sonar ~0,75 s antes del
  final del archivo (medido con `getPlayerStatus`: `curpos` no pasa de `totlen − 750 ms`), y Gemini
  deja solo 80-320 ms de silencio al final, así que sin relleno se comía la última palabra (BL-216).
  Se agrega al WAV solo en este canal; el Google Home no lo necesita. Tests: `node test_wav.js`.
- En DND: `skipped`, igual que `google_home`.

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

## Un aviso que no salió: se reintenta un rato, después vence

Desde BL-279 (2026-10-10), una falla **transitoria** —sin red, timeout, 5xx, 429— no gasta
`MAX_RETRIES`: el aviso queda `pending` y se reintenta con espera creciente (30 s, 60 s,
120 s… tope `REINTENTO_MAX_S`=15 min, columna `next_attempt_at`) hasta que **vence**. Es el
modelo de la cola de Postfix (`minimal/maximal_backoff_time` + `maximal_queue_lifetime`).
Si sale con más de `ATRASO_MIN`=10 min de atraso, la entrega lo dice: `⏰ atrasado` en
Telegram, `[atrasado]` en el asunto del mail, «aviso atrasado, de las HH:MM» en la voz.

El vencimiento es corto a propósito: **un aviso describe el estado del momento en que se
encoló, y entregarlo horas después informa mal**. El corte de luz del 2026-09-22
(INC-2026-036) dejó «eno1 sin ruta al gateway — requiere intervención manual», que tres horas
después era falso. Por eso:

| Canal | Vence a los | Variable |
|---|---|---|
| telegram, email | 3 h | `VENCIMIENTO_TEXTO_H` |
| google_home, wiim, lights | 30 min | `VENCIMIENTO_AL_OIDO_MIN` |

Un corte corto (el caso común: se cae internet unos minutos) ya no pierde avisos —antes, «Cierre
diario con errores» de cedears del 2026-10-02 quedó `failed` por un corte—; uno largo los
pierde igual que antes, y lo que corresponde avisar al volver es **que volvió** (`power-monitor`
y `boot-notify.sh`). Un aviso que vence queda `expired` (no `failed`: no hay nada roto que
arreglar, solo no hubo red a tiempo). Las fallas
**permanentes** (Telegram 4xx salvo 429, mail sin credenciales o dirección inválida, SMTP 5xx)
siguen cortando en `MAX_RETRIES` y quedan `failed`.

Consecuencia para el que llama: **si un aviso tiene que sobrevivir a un corte largo, la cola
del notifier no es el lugar.** Eso es estado, y va a un archivo o a una base que el proceso
relea al arrancar.

Tests: `node test_reintentos.js` (corre `processBatch` real sin red contra una cola temporal).

Los `failed` quedan en la cola como evidencia hasta que los borra la depuración
(`QUEUE_RETENTION_DAYS`); para verlos:

```bash
sqlite3 ~/notifier/queue.db "select id, created_at, source, substr(message,1,60) from queue where status='failed' order by id desc limit 10;"
```

Ojo con las horas: `created_at` se guarda en **UTC** y el log del servicio va en hora local
(-03), así que la misma entrega aparece con tres horas de diferencia según dónde se la mire.

## Depuración de la cola

Los registros con status `sent`, `failed`, `skipped` o `expired` se eliminan automáticamente al arrancar el servicio y cada hora. Retención configurable en `.env`:

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
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped | expired
  retries    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                    -- UTC; NULL = se puede mandar ya (reintento con espera)
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
- `error id=N retries=M status=pending próximo intento ... UTC` — falló, se reintenta
- `error id=N retries=M status=failed (permanente)` — no se entrega más: algo está roto
- `error id=N retries=M status=expired (vencido)` — no se entrega más: no hubo red a tiempo
- `vencido id=N` — llegó a su turno ya vencido (p. ej. el notifier estuvo parado)
- `sent id=N ... atrasado creado=dd/mm HH:MM` — entregado con atraso
