#!/usr/bin/env python3
"""Tests del origen que encola. Se corren con: python3 test_client.py

Cubren que `source` nunca quede en 'unknown' por olvido: el notifier estampa
el proceso a partir de ese campo, así que si llega vacío la regla no se cumple.
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import client  # noqa: E402


class TestOrigen(unittest.TestCase):
    def test_source_explicito_se_respeta(self):
        self.assertEqual(client._normalizar_origen("cedears/atribucion", False), "cedears/atribucion")

    def test_vacio_deriva_del_script_en_ejecucion(self):
        self.assertEqual(client._normalizar_origen("", False), "test_client")

    def test_unknown_tambien_deriva(self):
        self.assertEqual(client._normalizar_origen("unknown", False), "test_client")
        self.assertEqual(client._normalizar_origen("UNKNOWN", False), "test_client")

    def test_prueba_agrega_el_sufijo(self):
        self.assertEqual(client._normalizar_origen("vencimientos", True), "vencimientos/prueba")

    def test_prueba_no_duplica_el_sufijo(self):
        self.assertEqual(client._normalizar_origen("vencimientos/prueba", True), "vencimientos/prueba")

    def test_prueba_sin_source_deriva_y_marca(self):
        self.assertEqual(client._normalizar_origen("", True), "test_client/prueba")

    def test_origen_por_defecto_no_devuelve_vacio(self):
        argv = sys.argv
        try:
            for falso in ([], ["-c"], ["python3"], [""]):
                sys.argv = falso
                self.assertEqual(client._origen_por_defecto(), "desconocido")
        finally:
            sys.argv = argv


class TestEncolado(unittest.TestCase):
    """La fila insertada tiene que llevar el origen ya normalizado."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        con = sqlite3.connect(self.tmp.name)
        con.execute("""CREATE TABLE queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, message TEXT,
            priority INTEGER, silent INTEGER, analyze INTEGER, source TEXT,
            email_to TEXT, email_subject TEXT)""")
        con.commit()
        con.close()
        self.orig_db = client.DB_PATH
        client.DB_PATH = self.tmp.name

    def tearDown(self):
        client.DB_PATH = self.orig_db
        os.unlink(self.tmp.name)

    def _source_de(self, row_id):
        con = sqlite3.connect(self.tmp.name)
        valor = con.execute("SELECT source FROM queue WHERE id=?", (row_id,)).fetchone()[0]
        con.close()
        return valor

    def test_notify_sin_source_guarda_el_proceso_real(self):
        self.assertEqual(self._source_de(client.notify("hola")), "test_client")

    def test_notify_prueba_guarda_el_sufijo(self):
        self.assertEqual(self._source_de(client.notify("hola", prueba=True)), "test_client/prueba")

    def test_email_sigue_exigiendo_destinatario_valido(self):
        with self.assertRaises(ValueError):
            client.notify("hola", channel="email", email_to="no-es-mail")


if __name__ == "__main__":
    unittest.main(verbosity=2)
