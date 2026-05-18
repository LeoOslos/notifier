"""
Cliente Python para encolar notificaciones.
Uso:
    from client import notify
    notify("Se cayó Spectre")
    notify("Alerta crítica", priority=1)
"""

import sqlite3
import os

DB_PATH = os.environ.get("NOTIFIER_DB_PATH", os.path.expanduser("~/notifier/queue.db"))


def notify(message: str, channel: str = "telegram", priority: int = 5) -> int:
    con = sqlite3.connect(DB_PATH)
    cur = con.execute(
        "INSERT INTO queue (channel, message, priority) VALUES (?, ?, ?)",
        (channel, message, priority),
    )
    row_id = cur.lastrowid
    con.commit()
    con.close()
    return row_id
