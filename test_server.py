#!/usr/bin/env python3
"""
Pruebas automatizadas de integridad para el Árbol Genealógico (n-nupcias, layout, bajas y persistencia atómica).
Ejecutar con: python3 -m unittest test_server.py
"""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import server


class FamilyTreeServerTests(unittest.TestCase):
    def setUp(self):
        with open(server.DATA_FILE, "r", encoding="utf-8") as f:
            self.base_data = json.load(f)

    def test_preloaded_nupcias_examples_exist(self):
        members = self.base_data["members"]
        by_id = {m["id"]: m for m in members}

        # Caso 1: Pareja fallecida (Raúl Ferreyra † y Marta Álvarez) vinculados a Lucas Álvarez
        self.assertIn("pareja-tia-pat-1", by_id)
        self.assertIsNone(by_id["tia-pat"]["spouseId"])
        self.assertEqual(by_id["tia-pat"]["partnerships"][0]["status"], "deceased")
        self.assertEqual(by_id["primo-1"]["parentIds"], ["tia-pat", "pareja-tia-pat-1"])

        # Caso 2: Segundas nupcias (Jorge Conti con ex-pareja Valeria Ríos 1ª ♡ y actual Carolina Mendoza 2ª ♥)
        self.assertIn("ex-tio-mat", by_id)
        self.assertIn("pareja-tio-mat-2", by_id)
        self.assertEqual(by_id["tio-mat"]["spouseId"], "pareja-tio-mat-2")
        self.assertEqual(len(by_id["tio-mat"]["partnerships"]), 2)
        self.assertEqual(by_id["primo-2"]["parentIds"], ["tio-mat", "ex-tio-mat"])

    def test_sync_member_bidirectional_nupcias(self):
        members = [
            {"id": "m1", "name": "Ana", "generation": 2, "branch": "paterna", "partnerships": []},
            {"id": "m2", "name": "Bruno", "generation": 2, "branch": "paterna", "partnerships": []},
            {"id": "m3", "name": "Carlos", "generation": 2, "branch": "paterna", "partnerships": []},
            {"id": "h1", "name": "Hijo", "generation": 3, "branch": "paterna", "parentIds": []},
        ]
        updated_ana = {
            "id": "m1",
            "name": "Ana",
            "generation": 2,
            "branch": "paterna",
            "partnerships": [
                {"partnerId": "m2", "order": 1, "status": "previous", "period": "2000-2008"},
                {"partnerId": "m3", "order": 2, "status": "current", "period": "2012-Presente"},
            ],
        }
        replaced = server.sync_member_into_tree(members, updated_ana, children_ids=["h1"])
        self.assertTrue(replaced)

        by_id = {m["id"]: m for m in members}
        # Ana tiene como spouseId únicamente a la pareja actual (m3)
        self.assertEqual(by_id["m1"]["spouseId"], "m3")
        # Bruno (ex-pareja) recibe vínculo recíproco previous y spouseId = None
        self.assertIsNone(by_id["m2"]["spouseId"])
        self.assertEqual(by_id["m2"]["partnerships"][0]["partnerId"], "m1")
        self.assertEqual(by_id["m2"]["partnerships"][0]["status"], "previous")
        # Carlos (pareja actual) recibe vínculo recíproco current y spouseId = m1
        self.assertEqual(by_id["m3"]["spouseId"], "m1")
        self.assertEqual(by_id["m3"]["partnerships"][0]["order"], 2)
        # Hijo recibe a Ana en parentIds
        self.assertIn("m1", by_id["h1"]["parentIds"])

    def test_remove_member_cleans_all_references(self):
        data = copy.deepcopy(self.base_data)
        data["pendingApprovals"] = [{"id": "req-1", "targetMemberId": "ex-tio-mat"}]

        removed = server.remove_member_from_tree(data, "ex-tio-mat")
        self.assertIsNotNone(removed)

        by_id = {m["id"]: m for m in data["members"]}
        self.assertNotIn("ex-tio-mat", by_id)
        # Jorge ya no debe tener a ex-tio-mat en partnerships
        jorge_partners = [p["partnerId"] for p in by_id["tio-mat"]["partnerships"]]
        self.assertNotIn("ex-tio-mat", jorge_partners)
        # Sofía ya no debe tener a ex-tio-mat en parentIds
        self.assertNotIn("ex-tio-mat", by_id["primo-2"]["parentIds"])
        # Las aprobaciones pendientes de ese miembro se limpian
        self.assertEqual(len(data["pendingApprovals"]), 0)

    def test_tidy_layout_orders_nupcias_and_centers_children(self):
        members = copy.deepcopy(self.base_data["members"])
        server.tidy_family_layout(members)
        by_id = {m["id"]: m for m in members}

        # Ex-pareja (Valeria) queda a la izquierda de Jorge, y pareja actual (Carolina) a la derecha
        self.assertLess(by_id["ex-tio-mat"]["x"], by_id["tio-mat"]["x"])
        self.assertLess(by_id["tio-mat"]["x"], by_id["pareja-tio-mat-2"]["x"])
        self.assertEqual(by_id["tio-mat"]["x"] - by_id["ex-tio-mat"]["x"], 295)
        self.assertEqual(by_id["pareja-tio-mat-2"]["x"] - by_id["tio-mat"]["x"], 295)

        # Sofía (hija de Valeria y Jorge) queda centrada bajo el punto medio de ambos
        expected_mid = round((by_id["ex-tio-mat"]["x"] + by_id["tio-mat"]["x"]) / 2)
        self.assertEqual(by_id["primo-2"]["x"], expected_mid)

    def test_atomic_save_and_corrupt_state_recovery(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_state = Path(tmpdir) / "familia_estado.json"
            with mock.patch.object(server, "STATE_FILE", tmp_state):
                sample = copy.deepcopy(self.base_data)
                server.save_family_data(sample)
                self.assertTrue(tmp_state.exists())
                loaded = server.load_family_data()
                self.assertEqual(len(loaded["members"]), len(sample["members"]))

                # Si el archivo de estado se corrompe, load_family_data recupera el base sin crashear
                tmp_state.write_text("{corrupt-json", encoding="utf-8")
                recovered = server.load_family_data()
                self.assertEqual(len(recovered["members"]), len(self.base_data["members"]))


if __name__ == "__main__":
    unittest.main()
