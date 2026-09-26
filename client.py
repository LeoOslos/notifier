"""
Cliente Python para encolar notificaciones.
Uso:
    from client import notify
    notify("Se cayó Spectre")
    notify("Alerta crítica", priority=1)
    notify("Precio llegó al target", channel="telegram", silent=False)  # con sonido (si no es DND)
    notify("Parlante", channel="google_home")
    notify("Parlante", channel="wiim")
    notify("HA caído", priority=1, analyze=True)  # marca el evento para análisis autónomo
    notify("HA caído", priority=1, analyze=True, source="chequeo_ha")  # + origen p/ analyzer
    notify("Texto", channel="email", email_to="dest@gmail.com", email_subject="Asunto")
    notify("Probando el canal", prueba=True)   # sale como [PRUEBA] y lo dice el parlante

El campo `source` identifica al proceso que encola: si no se pasa, se deriva del script
en ejecución. El notifier lo estampa en el texto de Telegram y en el asunto del mail.
"""

import os
import re
import sqlite3
import sys

DB_PATH = os.environ.get("NOTIFIER_DB_PATH", os.path.expanduser("~/notifier/queue.db"))

_INSERT = (
    "INSERT INTO queue (channel, message, priority, silent, analyze, source, email_to, email_subject) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
)

# Migraciones idempotentes por si el daemon aún no creó la columna (ventana de deploy).
_MIGRATIONS = (
    "ALTER TABLE queue ADD COLUMN analyze INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE queue ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE queue ADD COLUMN email_to TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE queue ADD COLUMN email_subject TEXT NOT NULL DEFAULT ''",
)

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

SUFIJO_PRUEBA = "/prueba"


def _origen_por_defecto() -> str:
    """Nombre del proceso que encola, derivado del script en ejecución.

    Que el default sea el nombre real y no 'unknown' es lo que hace que la regla
    («toda notificación dice quién la encoló») no dependa de que el llamador se acuerde.
    """
    ruta = sys.argv[0] if sys.argv else ""
    nombre = os.path.splitext(os.path.basename(ruta))[0].strip()
    if not nombre or nombre.startswith("-") or nombre in ("python", "python3"):
        return "desconocido"
    return nombre


def _normalizar_origen(source: str, prueba: bool) -> str:
    origen = (source or "").strip().strip("/")
    if not origen or origen.lower() == "unknown":
        origen = _origen_por_defecto()
    if prueba and not origen.lower().endswith(SUFIJO_PRUEBA):
        origen += SUFIJO_PRUEBA
    return origen


def notify(
    message: str,
    channel: str = "telegram",
    priority: int = 5,
    silent: bool = True,
    analyze: bool = False,
    source: str = "",
    prueba: bool = False,
    email_to: str = "",
    email_subject: str = "",
) -> int:
    if channel == "email" and not _EMAIL_RE.match(email_to):
        raise ValueError(f"canal email requiere email_to válido. Recibido: {email_to!r}")
    # El notifier estampa el proceso y el [PRUEBA] a la salida a partir de este campo.
    source = _normalizar_origen(source, prueba)
    con = sqlite3.connect(DB_PATH)
    params = (channel, message, priority, 1 if silent else 0, 1 if analyze else 0, source, email_to, email_subject)
    try:
        cur = con.execute(_INSERT, params)
    except sqlite3.OperationalError as e:
        # Alguna columna puede no existir si el daemon aún no migró. Las creamos
        # idempotentemente y reintentamos.
        if "has no column" not in str(e):
            raise
        for ddl in _MIGRATIONS:
            try:
                con.execute(ddl)
            except sqlite3.OperationalError:
                pass  # ya existe
        cur = con.execute(_INSERT, params)
    row_id = cur.lastrowid
    con.commit()
    con.close()
    return row_id
