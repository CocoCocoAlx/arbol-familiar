#!/usr/bin/env python3
"""
Pruebas automatizadas de integridad para el Árbol Genealógico (n-nupcias, layout, bajas y persistencia atómica).
Ejecutar con: python3 -m unittest test_server.py
"""

import base64
import copy
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

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

    def test_ocr_audio_comments_and_invite_code_endpoints(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            tmp_state = tmp_path / "familia_estado.json"
            tmp_uploads = tmp_path / "uploads"

            with mock.patch.object(server, "STATE_FILE", tmp_state), mock.patch.object(
                server, "UPLOADS_DIR", tmp_uploads
            ):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.FamilyTreeHandler)
                port = httpd.server_address[1]
                th = threading.Thread(target=httpd.serve_forever, daemon=True)
                th.start()
                base_url = f"http://127.0.0.1:{port}"

                try:
                    # 0. Verificar que GET /api/family sin sesión oculta accessCodes
                    with urllib.request.urlopen(f"{base_url}/api/family", timeout=5) as resp:
                        pub_data = json.loads(resp.read().decode())
                    self.assertNotIn("accessCodes", pub_data.get("metadata", {}))

                    # 0b. Verificar que userEmail vacío no otorga rol Propietario (403)
                    req_empty_auth = urllib.request.Request(
                        f"{base_url}/api/family/delete-member",
                        data=json.dumps({"userEmail": "", "memberId": "abuelo-pat"}).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with self.assertRaises(urllib.error.HTTPError) as ctx_empty:
                        urllib.request.urlopen(req_empty_auth, timeout=5)
                    self.assertEqual(ctx_empty.exception.code, 403)

                    # 0c. Verificar sanitización de prefijo y base64 inválido en save_data_url_file
                    bad_url, bad_kb = server.save_data_url_file("data:image/jpeg;base64,!!!NOTBASE64!!!", "drive_fotos")
                    self.assertIsNone(bad_url)
                    self.assertEqual(bad_kb, 0)
                    safe_url, _ = server.save_data_url_file(
                        "data:image/png;base64,iVBORw0KGgo=", "drive_fotos", "../../evil"
                    )
                    self.assertTrue(safe_url.startswith("./uploads/drive_fotos/evil-"))

                    # 1. Preprocesado OCR
                    img = Image.new("RGB", (400, 120), "#f3e8d2")
                    ImageDraw.Draw(img).text((20, 40), "Carta 1965", fill="#251e19")
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG")
                    img_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

                    req_ocr = urllib.request.Request(
                        f"{base_url}/api/ocr",
                        data=json.dumps({"dataUrl": img_b64}).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req_ocr, timeout=5) as resp:
                        ocr_res = json.loads(resp.read().decode())
                    self.assertTrue(ocr_res["ok"])
                    self.assertTrue(ocr_res["enhancedDataUrl"].startswith("data:image/jpeg;base64,"))

                    # 2. Subida de Audio para Biografía (codec WebM/iOS)
                    audio_b64 = "data:audio/webm;codecs=opus;base64," + base64.b64encode(b"RIFFaudio").decode()
                    req_aud = urllib.request.Request(
                        f"{base_url}/api/family/upload",
                        data=json.dumps({
                            "userEmail": "martin.alvarez@gmail.com",
                            "memberId": "abuelo-pat",
                            "mediaType": "audio",
                            "audioTarget": "bio",
                            "title": "Relato oral",
                            "date": "2026",
                            "dataUrl": audio_b64,
                        }).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req_aud, timeout=5) as resp:
                        aud_res = json.loads(resp.read().decode())
                    self.assertTrue(aud_res["ok"])
                    self.assertTrue(aud_res["member"]["bioAudioUrl"].endswith(".webm"))

                    # 3. Comentario de lector y bloqueo 403 si un lector intenta resolverlo
                    req_cmt = urllib.request.Request(
                        f"{base_url}/api/family/comments",
                        data=json.dumps({
                            "authorName": "Lucía",
                            "memberId": "abuelo-pat",
                            "category": "Corrección de fecha o dato",
                            "message": "Nació en junio, no en mayo.",
                        }).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req_cmt, timeout=5) as resp:
                        cmt_res = json.loads(resp.read().decode())
                    self.assertTrue(cmt_res["ok"])
                    cmt_id = cmt_res["comment"]["id"]

                    req_block = urllib.request.Request(
                        f"{base_url}/api/family/comments/resolve",
                        data=json.dumps({
                            "userEmail": "lucia.alvarez@gmail.com",
                            "commentId": cmt_id,
                            "action": "resolved",
                        }).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with self.assertRaises(urllib.error.HTTPError) as ctx:
                        urllib.request.urlopen(req_block, timeout=5)
                    self.assertEqual(ctx.exception.code, 403)

                    # 4. Acceso por código PIN sin cuenta de Google
                    req_pin = urllib.request.Request(
                        f"{base_url}/api/family/auth-code",
                        data=json.dumps({"code": "FAMILIA-2026", "name": "Tía Marta"}).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req_pin, timeout=5) as resp:
                        pin_res = json.loads(resp.read().decode())
                    self.assertTrue(pin_res["ok"])
                    self.assertEqual(pin_res["role"], "Lector")

                    # 5. Co-editor no puede crear código Co-editor (se degrada a Lector) ni editar coEditors (403)
                    req_code_co = urllib.request.Request(
                        f"{base_url}/api/family/access-codes",
                        data=json.dumps({
                            "userEmail": "elena.conti@gmail.com",
                            "action": "create",
                            "code": "PRUEBA-99",
                            "label": "Test",
                            "role": "Co-editor",
                        }).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req_code_co, timeout=5) as resp:
                        code_res = json.loads(resp.read().decode())
                    created = [c for c in code_res["accessCodes"] if c["code"] == "PRUEBA-99"][0]
                    self.assertEqual(created["role"], "Lector")

                    req_perm_co = urllib.request.Request(
                        f"{base_url}/api/family/permissions",
                        data=json.dumps({
                            "requesterEmail": "elena.conti@gmail.com",
                            "coEditors": ["otro@gmail.com"],
                        }).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with self.assertRaises(urllib.error.HTTPError) as ctx_perm:
                        urllib.request.urlopen(req_perm_co, timeout=5)
                    self.assertEqual(ctx_perm.exception.code, 403)
                finally:
                    httpd.shutdown()


if __name__ == "__main__":
    unittest.main()
