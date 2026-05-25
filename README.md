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
- **Google Home:** el mensaje se entrega tal cual, sin prefijo de hora.

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
- `dnd: skipped id=N` — en horario DND, descartado (no se reintenta)
- `cast: ok NombreDispositivo` — Cast exitoso
- `cast: error NombreDispositivo: ...` — falló ese dispositivo (otros pueden haber funcionado)
- `error id=N retries=M status=failed` — agotó reintentos
