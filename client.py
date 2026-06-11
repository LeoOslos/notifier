"""
Cliente Python para encolar notificaciones.
Uso:
    from client import notify
    notify("Se cayó Spectre")
    notify("Alerta crítica", priority=1)
    notify("Precio llegó al target", channel="telegram", silent=False)  # con sonido (si no es DND)
    notify("Parlante", channel="google_home")
    notify("HA caído", priority=1, analyze=True)  # marca el evento para análisis autónomo
    notify("HA caído", priority=1, analyze=True, source="chequeo_ha")  # + origen p/ analyzer
"""

import sqlite3
import os

DB_PATH = os.environ.get("NOTIFIER_DB_PATH", os.path.expanduser("~/notifier/queue.db"))

_INSERT = (
    "INSERT INTO queue (channel, message, priority, silent, analyze, source) "
    "VALUES (?, ?, ?, ?, ?, ?)"
)

# Migraciones idempotentes por si el daemon aún no creó la columna (ventana de deploy).
_MIGRATIONS = (
    "ALTER TABLE queue ADD COLUMN analyze INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE queue ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'",
)


def notify(
    message: str,
    channel: str = "telegram",
    priority: int = 5,
    silent: bool = True,
    analyze: bool = False,
    source: str = "unknown",
) -> int:
    con = sqlite3.connect(DB_PATH)
    params = (channel, message, priority, 1 if silent else 0, 1 if analyze else 0, source)
    try:
        cur = con.execute(_INSERT, params)
    except sqlite3.OperationalError as e:
        # Alguna columna ('analyze'/'source') puede no existir si el daemon aún no
        # migró. Las creamos idempotentemente y reintentamos.
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
