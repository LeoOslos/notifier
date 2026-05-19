# Notifier

Servicio centralizado de notificaciones con cola persistente SQLite. Corre como proceso PM2 y soporta dos canales: Telegram y Google Home (TTS por Cast).

## Arquitectura

```
Script Python / CLI
       │
       ▼
   queue.db (SQLite)
       │
       ▼
  notifier.js (PM2, poll cada 2s)
       ├── telegram  → API Bot de Telegram
       └── google_home → cast_google_home.py → pychromecast → Google Home / Nest Hub / Chromecast
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
pip install pychromecast gtts
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
DND_CHANNELS=google_home  # canales bloqueados (separados por coma)

# Opcionales
TTS_PORT=9876
TTS_LANG=es
POLL_INTERVAL=2000
MAX_RETRIES=3
BATCH_SIZE=10
```

Después de editar `.env`: `pm2 restart notifier --update-env`

---

## Uso

### Desde Python

```python
from client import notify

notify("El script terminó")                              # telegram, silencioso
notify("Precio en target", silent=False)                 # telegram con sonido (si no es DND)
notify("Alerta crítica", priority=1)                     # telegram, prioridad alta, silencioso
notify("Proceso finalizado", channel="google_home")      # habla en todos los parlantes
```

### Desde CLI

```bash
node enqueue.js "mensaje"                        # telegram, silencioso
node enqueue.js "mensaje" telegram 1 0           # telegram, prioridad 1, con sonido
node enqueue.js "mensaje" google_home            # Google Home
```

## Formato de los mensajes entregados

El timestamp se agrega automáticamente al momento de enviar, reflejando cuándo ocurrió el evento (no cuándo se entregó — puede diferir si hubo DND).

- **Telegram:** `[18/05 22:08] El script terminó`
- **Google Home:** `A las 22:08, El script terminó`

---

## Canales

### telegram
- Siempre envía, nunca bloqueado por DND.
- Por defecto silencioso (`disable_notification: true`).
- `silent=0`: envía con sonido, excepto si está en horario DND → fuerza silencioso.

### google_home
- Genera TTS con gTTS, sirve el MP3 por HTTP desde `wlo1` (IP WiFi: 192.168.0.100).
- Usa pychromecast para castear a todos los dispositivos descubiertos en la red.
- Bloqueado en horario DND: los mensajes quedan `pending` y se procesan al salir del horario.

---

## Do Not Disturb

| Situación | google_home | telegram silent=1 | telegram silent=0 |
|-----------|-------------|-------------------|-------------------|
| Fuera de DND | envía | silencioso | con sonido |
| En DND (23-8h) | **skipped** | silencioso | silencioso |

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
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  retries    INTEGER NOT NULL DEFAULT 0,
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
- `dnd: omitiendo id=N` — en horario DND, se reintentará
- `cast: ok NombreDispositivo` — Cast exitoso
- `cast: error NombreDispositivo: ...` — falló ese dispositivo (otros pueden haber funcionado)
- `error id=N retries=M status=failed` — agotó reintentos
