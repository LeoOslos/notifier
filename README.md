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
pip install pychromecast edge-tts
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
TTS_VOICE=es-AR-TomasNeural   # voz TTS (edge-tts). Alternativa: es-AR-ElenaNeural
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

El parámetro `source` identifica qué servicio encoló la notificación. No afecta la
entrega; viaja en la fila para que el **analyzer** sepa el origen del incidente y
oriente el diagnóstico (ver su catálogo de monitores). Opcional, default `'unknown'`.

### Desde CLI

```bash
node enqueue.js "mensaje"                        # telegram, silencioso
node enqueue.js "mensaje" telegram 1 0           # telegram, prioridad 1, con sonido
node enqueue.js "mensaje" google_home            # Google Home
# args: "mensaje" [canal] [prioridad] [silent] [analyze] [source]
node enqueue.js "HA caído" telegram 1 0 1 chequeo_ha   # análisis autónomo + origen
# args email: "mensaje" email [prioridad] [silent] [analyze] [source] email_to email_subject
node enqueue.js "El cierre falló." email 5 1 0 cedears "dest@gmail.com" "[cedears] Error cierre"
```

## Formato de los mensajes entregados

El timestamp se agrega automáticamente al momento de enviar, reflejando cuándo ocurrió el evento (no cuándo se entregó — puede diferir si hubo DND).

- **Telegram:** `[18/05 22:08] El script terminó`
- **Google Home:** el mensaje se entrega tal cual, sin prefijo de hora.
- **Email:** From fijo `notifier <GMAIL_USER>`. Subject y destinatario definidos por el caller.

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
- Genera TTS con **edge-tts** (voz `es-AR-TomasNeural` por defecto — natural, argentina).
- Sirve el MP3 por HTTP desde `wlo1` (IP WiFi: 192.168.0.100), puerto 9876.
- Castea al dispositivo cuyo nombre contenga `GOOGLE_HOME_DEVICE` (substring, case-insensitive). Si está vacío, castea a todos.
- En DND: se marca `skipped` inmediatamente, nunca se entrega.

**Voces disponibles en español argentino:**
- `es-AR-TomasNeural` — masculina ✓ (default)
- `es-AR-ElenaNeural` — femenina

### email
- Envía via Gmail SMTP (nodemailer). Requiere `GMAIL_USER` y `GMAIL_APP_PASSWORD` en `.env`.
- From fijo: `"notifier" <GMAIL_USER>`. El proceso que invoca se identifica en el subject.
- Destinatario (`email_to`) y asunto (`email_subject`) definidos por el caller en cada mensaje.
- Valida formato de `email_to` antes de encolar (requiere `@` y dominio con `.`).
- **Nunca bloqueado por DND** — siempre entrega.
- Texto plano únicamente.

**Credenciales:** usar un App Password de Google (no la contraseña normal de la cuenta). Generarlo en `myaccount.google.com → Seguridad → Contraseñas de aplicaciones`.

---

## Do Not Disturb

| Situación | google_home | telegram silent=1 | telegram silent=0 | email |
|-----------|-------------|-------------------|-------------------|-------|
| Fuera de DND | envía | silencioso | con sonido | envía |
| En DND (23-8h) | **skipped** | silencioso | silencioso | envía |

`google_home` en DND se marca `skipped` inmediatamente — no se entrega nunca, queda como evidencia en la cola. No hay catarata de mensajes al salir del DND.

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
  source     TEXT    NOT NULL DEFAULT 'unknown',  -- qué servicio encoló (contexto p/ analyzer)
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
