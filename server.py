#!/usr/bin/env python3
"""
Servidor local para el prototipo del Árbol Genealógico Interactivo ("Lienzo Familiar").
Ejecutar con: python3 server.py
Puerto por defecto: 8765
"""

import base64
import io
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from PIL import Image, ImageEnhance, ImageOps
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
UPLOADS_DIR = PUBLIC_DIR / "uploads"
DATA_FILE = BASE_DIR / "data" / "familia.json"
STATE_FILE = BASE_DIR / "data" / "familia_estado.json"
PORT = int(os.environ.get("PORT", 8765))
MAX_BODY_BYTES = 25 * 1024 * 1024  # 25 MB máximo por petición POST
DATA_LOCK = threading.RLock()


class PayloadTooLargeError(Exception):
    pass


class BadJsonBodyError(Exception):
    pass


def now_str():
    return datetime.now().strftime("%d/%m/%Y %H:%M")


def default_history():
    return [
        {
            "id": "log-init-2",
            "timestamp": "04/11/2026 19:30",
            "actorEmail": "elena.conti@gmail.com",
            "actorRole": "Co-editor",
            "category": "media_uploaded",
            "summary": "Subió fotografía 'En el mostrador de la Relojería Il Tempo' a Google Drive",
            "details": "Familiar: Vittorio Conti · Optimizada a 15 KB",
        },
        {
            "id": "log-init-1",
            "timestamp": "04/11/2026 18:15",
            "actorEmail": "martin.alvarez@gmail.com",
            "actorRole": "Propietario",
            "category": "permissions_changed",
            "summary": "Creó el lienzo familiar y designó a elena.conti@gmail.com como Co-editora",
            "details": "12 integrantes iniciales cargados en 3 generaciones",
        },
    ]


def default_access_codes():
    return [
        {
            "code": "FAMILIA-2026",
            "label": "Acceso Familiar General",
            "role": "Lector",
            "createdAt": "17/11/2026 10:00",
        },
        {
            "code": "EDITOR-2026",
            "label": "Acceso Co-editor Familiar",
            "role": "Co-editor",
            "createdAt": "17/11/2026 10:00",
        },
    ]


def ensure_data_defaults(data):
    data.setdefault("pendingApprovals", [])
    data.setdefault("historyLog", default_history())
    data.setdefault("readerComments", [])
    meta = data.setdefault("metadata", {})
    if not isinstance(meta.get("accessCodes"), list) or len(meta["accessCodes"]) == 0:
        meta["accessCodes"] = default_access_codes()
    return data


def load_family_data():
    """Carga el archivo de estado si existe, o el archivo base original (protegido por lock)."""
    with DATA_LOCK:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            base_data = json.load(f)

        if STATE_FILE.exists():
            try:
                with open(STATE_FILE, "r", encoding="utf-8") as f:
                    state_data = json.load(f)
                meta = base_data.get("metadata", {})
                meta.update(state_data.get("metadata", {}))
                state_data["metadata"] = meta
                return ensure_data_defaults(state_data)
            except Exception as exc:
                print(f"[WARN] Estado corrupto en {STATE_FILE}, usando base: {exc}")

        return ensure_data_defaults(base_data)


def save_family_data(data):
    """Guarda todos los cambios de manera atómica (tmp + os.replace) para evitar corrupción de datos."""
    with DATA_LOCK:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = STATE_FILE.with_suffix(".json.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, STATE_FILE)


def get_user_role(data, user_email):
    if not user_email:
        return "Propietario"
    meta = data.get("metadata", {})
    owner = (meta.get("ownerEmail") or "martin.alvarez@gmail.com").lower()
    co_editors = [e.lower() for e in meta.get("coEditors", [])]
    clean = user_email.strip().lower()
    if clean == owner:
        return "Propietario"
    if clean in co_editors:
        return "Co-editor"
    if clean.startswith("codigo:"):
        code_val = clean.split("codigo:", 1)[1].strip().upper()
        for c in meta.get("accessCodes", []):
            if (c.get("code") or "").strip().upper() == code_val:
                return c.get("role") or "Lector"
    return "Lector"


def can_user_edit(data, user_email):
    return get_user_role(data, user_email) in ("Propietario", "Co-editor")


def add_history_entry(data, actor_email, category, summary, details=""):
    role = get_user_role(data, actor_email)
    entry = {
        "id": f"log-{int(time.time() * 1000)}",
        "timestamp": now_str(),
        "actorEmail": actor_email or "martin.alvarez@gmail.com",
        "actorRole": role,
        "category": category,
        "summary": summary,
        "details": details,
    }
    history = data.setdefault("historyLog", default_history())
    history.insert(0, entry)
    data["historyLog"] = history[:150]
    return entry


def get_member_partnerships(member):
    partnerships = member.get("partnerships")
    if isinstance(partnerships, list) and len(partnerships) > 0:
        return partnerships
    sp_id = member.get("spouseId")
    if sp_id:
        return [{"partnerId": sp_id, "order": 1, "status": "current", "period": ""}]
    return []


def are_partners_linked(m1, m2):
    id1, id2 = m1.get("id"), m2.get("id")
    if not id1 or not id2:
        return False
    for p in get_member_partnerships(m1):
        if p.get("partnerId") == id2:
            return True
    for p in get_member_partnerships(m2):
        if p.get("partnerId") == id1:
            return True
    return False


def tidy_family_layout(members):
    """
    Reordena geométricamente las tarjetas de TODOS los familiares actuales (incluyendo n-nupcias)
    por nivel generacional, rama y pareja, ubicando ex-parejas/fallecidos a un lado, pareja actual
    al otro, e hijos centrados debajo de la unión parental correspondiente.
    """
    if not members:
        return members

    gens = sorted(set(int(m.get("generation", 1)) for m in members))
    by_id = {m["id"]: m for m in members}
    branch_order = {"paterna": 0, "ambas": 1, "materna": 2}

    for row_idx, gen in enumerate(gens):
        row_y = 110 + row_idx * 270
        row_members = [m for m in members if int(m.get("generation", 1)) == gen]
        row_members.sort(
            key=lambda m: (branch_order.get(m.get("branch", "paterna"), 1), m.get("x", 0))
        )

        ordered_row = []
        visited = set()

        for m in row_members:
            if m["id"] in visited:
                continue

            # Si este miembro es pareja única de alguien que tiene múltiples nupcias en la misma generación,
            # usar al miembro con múltiples nupcias como núcleo del grupo
            m_parts = get_member_partnerships(m)
            hub = m
            if len(m_parts) == 1:
                other_id = m_parts[0].get("partnerId")
                other = by_id.get(other_id)
                if (
                    other
                    and int(other.get("generation", 1)) == gen
                    and other["id"] not in visited
                    and len(get_member_partnerships(other)) > 1
                ):
                    hub = other

            hub_parts = sorted(get_member_partnerships(hub), key=lambda p: int(p.get("order", 1)))
            if len(hub_parts) > 1:
                # Ubicar ex-parejas / parejas fallecidas a la izquierda del núcleo y pareja actual a la derecha
                left_partners = [
                     p for p in hub_parts if p.get("status") in ("previous", "deceased")
                ]
                right_partners = [
                    p for p in hub_parts if p.get("status") not in ("previous", "deceased")
                ]
                for p in left_partners:
                    pid = p.get("partnerId")
                    if pid in by_id and pid not in visited and int(by_id[pid].get("generation", 1)) == gen:
                        visited.add(pid)
                        ordered_row.append(by_id[pid])
                if hub["id"] not in visited:
                    visited.add(hub["id"])
                    ordered_row.append(hub)
                for p in right_partners:
                    pid = p.get("partnerId")
                    if pid in by_id and pid not in visited and int(by_id[pid].get("generation", 1)) == gen:
                        visited.add(pid)
                        ordered_row.append(by_id[pid])
            else:
                visited.add(m["id"])
                ordered_row.append(m)
                if len(m_parts) == 1:
                    sp_id = m_parts[0].get("partnerId")
                    if sp_id and sp_id in by_id and sp_id not in visited:
                        sp = by_id[sp_id]
                        if int(sp.get("generation", 1)) == gen:
                            visited.add(sp_id)
                            ordered_row.append(sp)

        # Distribuir horizontalmente respetando la unión parental si tienen padres en la fila superior
        has_parents_in_tree = any(
            any(pid in by_id for pid in (m.get("parentIds") or [])) for m in ordered_row
        )
        if has_parents_in_tree and row_idx > 0:
            # Agrupar por conjunto de padres para centrar hermanos bajo su unión parental
            groups = []
            idx = 0
            while idx < len(ordered_row):
                curr = ordered_row[idx]
                pids = tuple(sorted(pid for pid in (curr.get("parentIds") or []) if pid in by_id))
                grp = [curr]
                idx += 1
                while idx < len(ordered_row):
                    nxt = ordered_row[idx]
                    nxt_pids = tuple(sorted(pid for pid in (nxt.get("parentIds") or []) if pid in by_id))
                    if pids and nxt_pids == pids:
                        grp.append(nxt)
                        idx += 1
                    elif are_partners_linked(grp[-1], nxt):
                        grp.append(nxt)
                        idx += 1
                    else:
                        break
                groups.append((pids, grp))

            min_next_x = 100
            for pids, grp in groups:
                step = 295
                grp_span = (len(grp) - 1) * step
                if pids:
                    parent_xs = [by_id[pid].get("x", 200) for pid in pids if pid in by_id]
                    center_x = sum(parent_xs) / len(parent_xs)
                    start_x = round(center_x - grp_span / 2)
                else:
                    start_x = min_next_x
                start_x = max(min_next_x, start_x)
                for i, member_item in enumerate(grp):
                    member_item["x"] = start_x + i * step
                    member_item["y"] = row_y
                min_next_x = start_x + grp_span + 335
        else:
            cur_x = 100 if len(ordered_row) > 5 else 240
            for idx, m in enumerate(ordered_row):
                m["x"] = cur_x
                m["y"] = row_y
                if idx + 1 < len(ordered_row) and are_partners_linked(m, ordered_row[idx + 1]):
                    cur_x += 295
                else:
                    cur_x += 355

    return members


def sync_member_into_tree(members, updated_member, children_ids=None):
    """
    Inserta o actualiza un familiar en la lista `members`, normalizando sus nupcias (`partnerships`),
    sincronizando recíprocamente a todas las parejas vinculadas y vinculando hijos seleccionados.
    Retorna True si el miembro ya existía (edición) o False si es nuevo (alta).
    """
    member_id = updated_member["id"]
    replaced = False
    for idx, existing in enumerate(members):
        if existing.get("id") == member_id:
            members[idx] = updated_member
            replaced = True
            break
    if not replaced:
        members.append(updated_member)

    raw_partnerships = updated_member.get("partnerships")
    if not isinstance(raw_partnerships, list):
        sp_legacy = updated_member.get("spouseId")
        raw_partnerships = (
            [{"partnerId": sp_legacy, "order": 1, "status": "current", "period": ""}]
            if sp_legacy
            else []
        )
    cleaned_partnerships = []
    seen_pids = set()
    for idx_p, p in enumerate(raw_partnerships):
        pid = (p.get("partnerId") or "").strip()
        if not pid or pid == member_id or pid in seen_pids:
            continue
        seen_pids.add(pid)
        cleaned_partnerships.append(
            {
                "partnerId": pid,
                "order": int(p.get("order") or (idx_p + 1)),
                "status": p.get("status") or "current",
                "period": (p.get("period") or "").strip(),
            }
        )
    updated_member["partnerships"] = cleaned_partnerships
    current_partner = next(
        (p["partnerId"] for p in cleaned_partnerships if p.get("status") == "current"),
        None,
    )
    updated_member["spouseId"] = current_partner

    partner_map = {p["partnerId"]: p for p in cleaned_partnerships}
    for m in members:
        if m["id"] == member_id:
            continue
        m_parts = list(get_member_partnerships(m))
        if m["id"] in partner_map:
            p_info = partner_map[m["id"]]
            reciprocal = {
                "partnerId": member_id,
                "order": p_info["order"],
                "status": p_info["status"],
                "period": p_info.get("period", ""),
            }
            replaced_rec = False
            for i_mp, mp in enumerate(m_parts):
                if mp.get("partnerId") == member_id:
                    m_parts[i_mp] = reciprocal
                    replaced_rec = True
                    break
            if not replaced_rec:
                m_parts.append(reciprocal)
        else:
            m_parts = [mp for mp in m_parts if mp.get("partnerId") != member_id]
        m["partnerships"] = m_parts
        m_curr = next(
            (mp["partnerId"] for mp in m_parts if mp.get("status") == "current"),
            None,
        )
        m["spouseId"] = m_curr

    if isinstance(children_ids, list) and len(children_ids) > 0:
        for m in members:
            if m["id"] in children_ids:
                pids = m.setdefault("parentIds", [])
                if member_id not in pids:
                    pids.append(member_id)

    return replaced


def remove_member_from_tree(data, target_id):
    members = data.get("members", [])
    target = next((m for m in members if m.get("id") == target_id), None)
    if not target:
        return None
    data["members"] = [m for m in members if m.get("id") != target_id]
    for m in data["members"]:
        if m.get("spouseId") == target_id:
            m["spouseId"] = None
        if isinstance(m.get("partnerships"), list):
            m["partnerships"] = [
                p for p in m["partnerships"] if p.get("partnerId") != target_id
            ]
        if "parentIds" in m and target_id in m["parentIds"]:
            m["parentIds"] = [pid for pid in m["parentIds"] if pid != target_id]
    # Limpiar solicitudes pendientes asociadas a ese miembro
    data["pendingApprovals"] = [
        req for req in data.get("pendingApprovals", []) if req.get("targetMemberId") != target_id
    ]
    return target


def save_data_url_file(data_url, subfolder, prefix="archivo"):
    if not data_url or not data_url.startswith("data:"):
        return None, 0

    match = re.match(r"^data:([^;,]+)(?:;[^,]+)*;base64,(.+)$", data_url, re.DOTALL)
    if not match:
        return None, 0

    mime_type = match.group(1).strip().lower()
    b64_data = match.group(2)
    raw_bytes = base64.b64decode(b64_data)

    ext_map = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/quicktime": ".mov",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/wave": ".wav",
        "audio/ogg": ".ogg",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/webm": ".webm",
    }
    ext = ext_map.get(mime_type, ".bin")
    target_dir = UPLOADS_DIR / subfolder
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{prefix}-{int(time.time() * 1000)}{ext}"
    file_path = target_dir / filename
    with open(file_path, "wb") as f:
        f.write(raw_bytes)

    size_kb = max(1, round(len(raw_bytes) / 1024))
    return f"./uploads/{subfolder}/{filename}", size_kb


def preprocess_image_for_ocr(data_url):
    """
    Preprocesa la fotografía o escaneo de una carta (realce de contraste en papel antiguo)
    para facilitar tanto el OCR (Tesseract.js / Tesseract / Drive OCR) como la lectura visual.
    """
    if not data_url or not data_url.startswith("data:"):
        return {"ok": False, "error": "Imagen inválida para OCR"}

    match = re.match(r"^data:([^;,]+)(?:;[^,]+)*;base64,(.+)$", data_url, re.DOTALL)
    if not match:
        return {"ok": False, "error": "Formato base64 inválido"}

    raw_bytes = base64.b64decode(match.group(2))
    enhanced_data_url = data_url
    width, height = 0, 0
    server_text = ""
    server_ocr_used = False

    if HAS_PIL:
        try:
            img = Image.open(io.BytesIO(raw_bytes))
            img = ImageOps.exif_transpose(img)
            width, height = img.size

            if width < 1000:
                ratio = 1200 / max(1, width)
                img = img.resize((int(width * ratio), int(height * ratio)), Image.Resampling.LANCZOS)
            elif width > 2200:
                ratio = 2000 / width
                img = img.resize((int(width * ratio), int(height * ratio)), Image.Resampling.LANCZOS)

            gray = ImageOps.grayscale(img)
            gray = ImageOps.autocontrast(gray, cutoff=2)
            gray = ImageEnhance.Contrast(gray).enhance(1.55)
            gray = ImageEnhance.Sharpness(gray).enhance(1.7)

            buf = io.BytesIO()
            gray.save(buf, format="JPEG", quality=88)
            enhanced_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            enhanced_data_url = f"data:image/jpeg;base64,{enhanced_b64}"

            tesseract_bin = shutil.which("tesseract")
            if tesseract_bin:
                tmp_path = BASE_DIR / "data" / f"tmp-ocr-{int(time.time() * 1000)}.jpg"
                tmp_path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    gray.save(tmp_path, format="JPEG", quality=92)
                    proc = subprocess.run(
                        [tesseract_bin, str(tmp_path), "stdout", "-l", "spa+eng"],
                        capture_output=True,
                        text=True,
                        timeout=20,
                    )
                    if proc.returncode == 0 and proc.stdout.strip():
                        server_text = proc.stdout.strip()
                        server_ocr_used = True
                finally:
                    if tmp_path.exists():
                        tmp_path.unlink()
        except Exception as e:
            return {"ok": False, "error": f"Error procesando imagen: {e}"}

    return {
        "ok": True,
        "enhancedDataUrl": enhanced_data_url,
        "width": width,
        "height": height,
        "serverOcrUsed": server_ocr_used,
        "serverText": server_text,
        "pilEnabled": HAS_PIL,
    }


class FamilyTreeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            raise BadJsonBodyError("Content-Length inválido")
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise PayloadTooLargeError(
                f"El archivo supera el límite permitido de {MAX_BODY_BYTES // (1024 * 1024)} MB"
            )
        try:
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BadJsonBodyError(f"Cuerpo JSON malformado: {exc}")

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/family":
            data = load_family_data()
            return self._send_json(data)

        if parsed.path == "/api/family/comments":
            data = load_family_data()
            return self._send_json({"ok": True, "comments": data.get("readerComments", [])})

        if parsed.path == "/fallback-data.js":
            data = load_family_data()
            js_body = f"window.FALLBACK_FAMILY_DATA = {json.dumps(data, ensure_ascii=False)};\n".encode(
                "utf-8"
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(js_body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(js_body)
            return

        if parsed.path == "/api/tts":
            qs = parse_qs(parsed.query)
            text = (qs.get("text", [""])[0] or "").strip()
            voice = (qs.get("voice", ["es-419+m3"])[0] or "es-419+m3").strip()
            speed = int(qs.get("speed", ["138"])[0] or 138)
            pitch = int(qs.get("pitch", ["45"])[0] or 45)

            if not text:
                self.send_error(400, "Falta texto")
                return

            if not voice.startswith("es"):
                voice = "es-419+m3"
            speed = max(100, min(180, speed))
            pitch = max(25, min(75, pitch))

            try:
                proc = subprocess.run(
                    [
                        "espeak-ng",
                        "-v",
                        voice,
                        "-s",
                        str(speed),
                        "-p",
                        str(pitch),
                        "--stdout",
                        text,
                    ],
                    capture_output=True,
                    timeout=10,
                    check=True,
                )
                wav_bytes = proc.stdout
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav_bytes)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(wav_bytes)
                return
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, 500)

        return super().do_GET()

    def do_POST(self):
        try:
            with DATA_LOCK:
                return self._handle_post()
        except PayloadTooLargeError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 413)
        except BadJsonBodyError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 400)

    def _handle_post(self):
        parsed = urlparse(self.path)

        # 1. Gestión de Permisos (Propietario gestiona todo; Co-editores gestionan Lectores)
        if parsed.path == "/api/family/permissions":
            body = self._read_body_json()
            requester = (body.get("requesterEmail") or "").strip().lower()
            action_desc = body.get("actionDesc") or "Actualizó la lista de accesos del lienzo"
            data = load_family_data()
            meta = data.setdefault("metadata", {})
            owner = (meta.get("ownerEmail") or "martin.alvarez@gmail.com").lower()
            role = get_user_role(data, requester)

            if role not in ("Propietario", "Co-editor"):
                return self._send_json(
                    {"ok": False, "error": "No tienes permisos para gestionar usuarios."},
                    403,
                )

            # Solo el Propietario puede modificar la lista de Co-editores
            if "coEditors" in body:
                if role != "Propietario":
                    return self._send_json(
                        {"ok": False, "error": "Solo el propietario puede añadir, editar o eliminar co-editores."},
                        403,
                    )
                co_editors = [
                    e.strip().lower()
                    for e in body["coEditors"]
                    if e.strip() and e.strip().lower() != owner
                ]
                meta["coEditors"] = list(dict.fromkeys(co_editors))

            # Tanto el Propietario como los Co-editores pueden añadir/editar/eliminar Lectores
            if "allowedEmails" in body:
                incoming = [e.strip().lower() for e in body["allowedEmails"] if e.strip()]
                # Garantizar que ni el propietario ni los co-editores actuales sean borrados por un co-editor
                protected = [owner] + [ce.lower() for ce in meta.get("coEditors", [])]
                final_allowed = []
                for p in protected:
                    if p not in final_allowed:
                        final_allowed.append(p)
                for email in incoming:
                    if email not in final_allowed:
                        final_allowed.append(email)
                meta["allowedEmails"] = final_allowed

            add_history_entry(data, requester, "permissions_changed", action_desc)
            save_family_data(data)
            return self._send_json(
                {"ok": True, "metadata": meta, "historyLog": data.get("historyLog", [])}
            )

        # 2. Guardar posiciones en el lienzo
        if parsed.path == "/api/family/positions":
            body = self._read_body_json()
            user_email = body.get("userEmail")
            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json({"ok": False, "error": "Modo solo lectura"}, 403)

            positions = body.get("positions", {})
            for member in data.get("members", []):
                mid = member.get("id")
                if mid in positions:
                    member["x"] = round(float(positions[mid]["x"]))
                    member["y"] = round(float(positions[mid]["y"]))
            save_family_data(data)
            return self._send_json({"ok": True, "updated": len(positions)})

        # 3. Ordenar geométricamente el tablero SIN borrar parientes nuevos
        if parsed.path in ("/api/family/tidy", "/api/family/reset"):
            body = self._read_body_json()
            user_email = body.get("userEmail") or "martin.alvarez@gmail.com"
            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json({"ok": False, "error": "Modo solo lectura"}, 403)

            tidy_family_layout(data.get("members", []))
            add_history_entry(
                data,
                user_email,
                "layout_tidied",
                "Ordenó y alineó automáticamente las tarjetas del lienzo",
                f"Se organizaron los {len(data.get('members', []))} familiares conservando todos los datos.",
            )
            save_family_data(data)
            return self._send_json({"ok": True, "data": data})

        # 4. Preprocesamiento + OCR local para Cartas Manuscritas o Impresas
        if parsed.path == "/api/ocr":
            body = self._read_body_json()
            data_url = body.get("dataUrl")
            result = preprocess_image_for_ocr(data_url)
            status = 200 if result.get("ok") else 400
            return self._send_json(result, status)

        # 5. Subida unificada de Material al Drive del Propietario / YouTube / Audios / Cartas + OCR
        if parsed.path == "/api/family/upload":
            body = self._read_body_json()
            user_email = body.get("userEmail") or "martin.alvarez@gmail.com"
            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json({"ok": False, "error": "Sin permiso de edición"}, 403)

            member_id = body.get("memberId")
            media_type = body.get("mediaType")
            title = (body.get("title") or "Archivo familiar").strip()
            year_or_date = (body.get("date") or "Archivo").strip()
            description = (body.get("description") or "").strip()
            data_url = body.get("dataUrl")
            audio_data_url = body.get("audioDataUrl")
            youtube_upload = bool(body.get("youtubeUpload", True))
            paper_type = body.get("paperType") or "aged-cream"

            ocr_enabled = bool(body.get("ocrEnabled", False))
            ocr_status = body.get("ocrStatus") or ("manual" if description else "image_only")
            ocr_raw_text = (body.get("ocrRawText") or "").strip()
            enhanced_scan_url = None
            if body.get("enhancedDataUrl"):
                enhanced_scan_url, _ = save_data_url_file(
                    body.get("enhancedDataUrl"), "drive_cartas", f"ocr-{member_id}"
                )

            target_member = next(
                (m for m in data.get("members", []) if m.get("id") == member_id), None
            )
            if not target_member:
                return self._send_json({"ok": False, "error": "Familiar no encontrado"}, 404)

            drive_root = data.get("metadata", {}).get(
                "driveRootFolder", "Mi Unidad / Archivo_Familiar_Alvarez_Conti"
            )

            if media_type == "photo":
                local_url, size_kb = save_data_url_file(data_url, "drive_fotos", f"foto-{member_id}")
                photo_obj = {
                    "id": f"foto-{int(time.time() * 1000)}",
                    "title": title,
                    "year": year_or_date,
                    "caption": description or "Subida al Google Drive del propietario.",
                    "imageUrl": local_url,
                    "drivePath": f"{drive_root}/Fotos/{target_member['name']}/{title}.webp",
                    "sizeKB": size_kb or 16,
                    "uploadedBy": user_email,
                }
                target_member.setdefault("photos", []).append(photo_obj)
                add_history_entry(
                    data,
                    user_email,
                    "media_uploaded",
                    f"Subió fotografía '{title}' ({year_or_date}) a Google Drive",
                    f"Familiar: {target_member['name']} · Ruta: {photo_obj['drivePath']}",
                )

            elif media_type == "letter":
                local_url, size_kb = save_data_url_file(data_url, "drive_cartas", f"carta-{member_id}")
                custom_audio_url, audio_kb = save_data_url_file(
                    audio_data_url, "drive_audios", f"carta-audio-{member_id}"
                )
                paragraphs = [p.strip() for p in description.split("\n") if p.strip()]
                if not paragraphs and ocr_status != "image_only":
                    paragraphs = []

                letter_obj = {
                    "id": f"carta-{int(time.time() * 1000)}",
                    "title": title,
                    "date": year_or_date,
                    "location": "Subida a Google Drive",
                    "paperType": paper_type,
                    "inkColor": "#251e19",
                    "scanImageUrl": local_url,
                    "enhancedScanUrl": enhanced_scan_url,
                    "customAudioUrl": custom_audio_url,
                    "customAudioSizeKB": audio_kb or 0,
                    "ocrEnabled": ocr_enabled,
                    "ocrStatus": ocr_status,
                    "ocrRawText": ocr_raw_text,
                    "drivePath": f"{drive_root}/Cartas/{target_member['name']}/{title}.jpg",
                    "driveSizeKB": size_kb or 18,
                    "paragraphs": paragraphs,
                    "uploadedBy": user_email,
                }
                target_member.setdefault("letters", []).append(letter_obj)
                ocr_tag = (
                    " · OCR Aprobado"
                    if ocr_status == "approved"
                    else " · OCR Pendiente de revisión"
                    if ocr_status == "pending_review"
                    else ""
                )
                audio_tag = " + Audio original" if custom_audio_url else ""
                add_history_entry(
                    data,
                    user_email,
                    "media_uploaded",
                    f"Subió carta '{title}' ({year_or_date}){ocr_tag}{audio_tag}",
                    f"Familiar: {target_member['name']} · {len(paragraphs)} párrafo(s)",
                )

            elif media_type == "audio":
                audio_url, audio_kb = save_data_url_file(
                    data_url or audio_data_url, "drive_audios", f"audio-{member_id}"
                )
                audio_target = body.get("audioTarget") or "bio"
                if not audio_url:
                    return self._send_json(
                        {"ok": False, "error": "No se recibió archivo o grabación de audio válida."},
                        400,
                    )

                if audio_target.startswith("letter:"):
                    letter_id = audio_target.split("letter:", 1)[1]
                    target_letter = next(
                        (l for l in target_member.get("letters", []) if l.get("id") == letter_id),
                        None,
                    )
                    if target_letter:
                        target_letter["customAudioUrl"] = audio_url
                        target_letter["customAudioTitle"] = title
                        target_letter["customAudioSizeKB"] = audio_kb
                        target_letter["customAudioDate"] = year_or_date
                        add_history_entry(
                            data,
                            user_email,
                            "media_uploaded",
                            f"Subió audio '{title}' para la carta '{target_letter.get('title')}'",
                            f"Familiar: {target_member['name']} · {audio_kb} KB",
                        )
                    else:
                        return self._send_json({"ok": False, "error": "Carta destino no encontrada"}, 404)
                else:
                    target_member["bioAudioUrl"] = audio_url
                    target_member["bioAudioTitle"] = title
                    target_member["bioAudioSizeKB"] = audio_kb
                    target_member["bioAudioYear"] = year_or_date
                    target_member["bioAudioNote"] = description
                    add_history_entry(
                        data,
                        user_email,
                        "media_uploaded",
                        f"Subió audio de biografía '{title}' ({year_or_date})",
                        f"Familiar: {target_member['name']} · {audio_kb} KB",
                    )

            elif media_type == "video":
                subfolder = "youtube_precarga" if youtube_upload else "drive_videos"
                local_url, size_kb = save_data_url_file(data_url, subfolder, f"video-{member_id}")
                vid_id = f"vid-{int(time.time() * 1000)}"
                video_obj = {
                    "id": vid_id,
                    "title": title,
                    "year": year_or_date,
                    "duration": "Archivo subido",
                    "videoUrl": local_url,
                    "uploadedToYoutube": youtube_upload,
                    "youtubeUnlistedId": f"yt-unlisted-{vid_id}" if youtube_upload else None,
                    "drivePath": f"{drive_root}/Videos/{target_member['name']}/{title}.mp4",
                    "sizeKB": size_kb or 420,
                    "uploadedBy": user_email,
                    "description": description
                    or (
                        "Subido automáticamente a YouTube (Oculto) y precargado con calidad adaptativa."
                        if youtube_upload
                        else "Almacenado directamente en el Google Drive del propietario (sin subir a YouTube)."
                    ),
                }
                target_member.setdefault("videos", []).append(video_obj)
                destino_txt = "Google Drive + Precarga YouTube Oculto" if youtube_upload else "Solo Google Drive del Propietario"
                add_history_entry(
                    data,
                    user_email,
                    "media_uploaded",
                    f"Subió video '{title}' ({year_or_date}) [{destino_txt}]",
                    f"Familiar: {target_member['name']}",
                )

            save_family_data(data)
            return self._send_json(
                {"ok": True, "member": target_member, "historyLog": data.get("historyLog", [])}
            )

        # 5b. Corregir y/o Aprobar texto OCR de una carta existente
        if parsed.path == "/api/family/update-letter-ocr":
            body = self._read_body_json()
            user_email = body.get("userEmail") or "martin.alvarez@gmail.com"
            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json({"ok": False, "error": "Sin permiso de edición"}, 403)

            member_id = body.get("memberId")
            letter_id = body.get("letterId")
            text = (body.get("text") or "").strip()
            ocr_status = body.get("ocrStatus") or "approved"

            target_member = next(
                (m for m in data.get("members", []) if m.get("id") == member_id), None
            )
            if not target_member:
                return self._send_json({"ok": False, "error": "Familiar no encontrado"}, 404)

            target_letter = next(
                (l for l in target_member.get("letters", []) if l.get("id") == letter_id), None
            )
            if not target_letter:
                return self._send_json({"ok": False, "error": "Carta no encontrada"}, 404)

            paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
            target_letter["paragraphs"] = paragraphs
            target_letter["ocrStatus"] = ocr_status
            target_letter["ocrReviewedBy"] = user_email
            target_letter["ocrReviewedAt"] = now_str()

            estado_lbl = "✅ Aprobó" if ocr_status == "approved" else "📝 Editó borrador OCR de"
            add_history_entry(
                data,
                user_email,
                "media_uploaded",
                f"{estado_lbl} transcripción OCR de la carta '{target_letter.get('title')}'",
                f"Familiar: {target_member['name']} · {len(paragraphs)} párrafo(s)",
            )
            save_family_data(data)
            return self._send_json(
                {"ok": True, "member": target_member, "historyLog": data.get("historyLog", [])}
            )

        # 6. Crear o actualizar un familiar (con foto circular de retrato si se envía avatarDataUrl)
        if parsed.path == "/api/family/member":
            body = self._read_body_json()
            user_email = body.get("userEmail") or "martin.alvarez@gmail.com"
            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json({"ok": False, "error": "Sin permiso de edición"}, 403)

            updated_member = body.get("member")
            children_ids = body.get("childrenIds", [])
            avatar_data_url = body.get("avatarDataUrl")
            if not updated_member or not updated_member.get("id"):
                return self._send_json({"ok": False, "error": "Familiar inválido"}, 400)

            if avatar_data_url:
                avatar_url, _ = save_data_url_file(
                    avatar_data_url, "drive_retratos", f"retrato-{updated_member['id']}"
                )
                if avatar_url:
                    updated_member["avatarUrl"] = avatar_url

            members = data.get("members", [])
            replaced = sync_member_into_tree(members, updated_member, children_ids)

            action_cat = "member_edited" if replaced else "member_added"
            action_verb = "Editó los datos de" if replaced else "Agregó al árbol a"
            add_history_entry(
                data,
                user_email,
                action_cat,
                f"{action_verb} {updated_member.get('name')} ({updated_member.get('role')} · Nivel {updated_member.get('generation')})",
                f"Rama: {updated_member.get('branch')} · Origen: {updated_member.get('birthPlace')}",
            )

            save_family_data(data)
            return self._send_json(
                {
                    "ok": True,
                    "member": updated_member,
                    "members": members,
                    "historyLog": data.get("historyLog", []),
                }
            )

        # 6. Eliminar familiar o solicitar Validación del Propietario (si es Co-editor)
        if parsed.path == "/api/family/delete-member":
            body = self._read_body_json()
            user_email = (body.get("userEmail") or "").strip().lower()
            target_id = body.get("memberId")
            reason = (body.get("reason") or "Solicitud de eliminación desde el lienzo").strip()

            data = load_family_data()
            role = get_user_role(data, user_email)
            if role not in ("Propietario", "Co-editor"):
                return self._send_json({"ok": False, "error": "Sin permiso"}, 403)

            target_member = next(
                (m for m in data.get("members", []) if m.get("id") == target_id), None
            )
            if not target_member:
                return self._send_json({"ok": False, "error": "Familiar no encontrado"}, 404)

            # Si es el Propietario, elimina de forma directa
            if role == "Propietario":
                removed = remove_member_from_tree(data, target_id)
                add_history_entry(
                    data,
                    user_email,
                    "approval_resolved",
                    f"Eliminó directamente al familiar {removed['name']} ({removed['role']})",
                    f"Motivo: {reason}",
                )
                save_family_data(data)
                return self._send_json(
                    {
                        "ok": True,
                        "status": "deleted",
                        "data": data,
                    }
                )

            # Si es Co-editor, crea una solicitud de validación pendiente para el Propietario
            pending = data.setdefault("pendingApprovals", [])
            already = next(
                (r for r in pending if r.get("targetMemberId") == target_id), None
            )
            if not already:
                req_obj = {
                    "id": f"req-{int(time.time() * 1000)}",
                    "type": "delete_member",
                    "targetMemberId": target_id,
                    "targetMemberName": target_member["name"],
                    "targetMemberRole": target_member["role"],
                    "requestedBy": user_email,
                    "requestedByRole": "Co-editor",
                    "reason": reason,
                    "createdAt": now_str(),
                }
                pending.insert(0, req_obj)
                add_history_entry(
                    data,
                    user_email,
                    "approval_requested",
                    f"Solicitó autorización al propietario para eliminar a {target_member['name']} ({target_member['role']})",
                    f"Motivo indicado por el co-editor: {reason}",
                )
                save_family_data(data)

            return self._send_json(
                {
                    "ok": True,
                    "status": "pending_approval",
                    "data": data,
                }
            )

        # 7. Resolver solicitud de validación (Exclusivo para el Propietario)
        if parsed.path == "/api/family/resolve-approval":
            body = self._read_body_json()
            user_email = (body.get("userEmail") or "").strip().lower()
            req_id = body.get("requestId")
            decision = body.get("decision")  # 'approve' | 'reject'

            data = load_family_data()
            if get_user_role(data, user_email) != "Propietario":
                return self._send_json(
                    {"ok": False, "error": "Solo el propietario puede aprobar o rechazar decisiones."},
                    403,
                )

            pending = data.get("pendingApprovals", [])
            req_obj = next((r for r in pending if r.get("id") == req_id), None)
            if not req_obj:
                return self._send_json({"ok": False, "error": "Solicitud no encontrada"}, 404)

            data["pendingApprovals"] = [r for r in pending if r.get("id") != req_id]

            if decision == "approve":
                removed = remove_member_from_tree(data, req_obj["targetMemberId"])
                member_label = removed["name"] if removed else req_obj["targetMemberName"]
                add_history_entry(
                    data,
                    user_email,
                    "approval_resolved",
                    f"✅ Aprobó la solicitud de {req_obj['requestedBy']} y eliminó a {member_label}",
                    f"Motivo original: {req_obj.get('reason', '')}",
                )
            else:
                add_history_entry(
                    data,
                    user_email,
                    "approval_resolved",
                    f"❌ Rechazó la solicitud de {req_obj['requestedBy']} para eliminar a {req_obj['targetMemberName']}",
                    "El familiar se mantiene en el árbol.",
                )

            save_family_data(data)
            return self._send_json({"ok": True, "decision": decision, "data": data})

        # 8. Comentarios y sugerencias de lectores para editores/co-editores
        if parsed.path == "/api/family/comments":
            body = self._read_body_json()
            author_name = (body.get("authorName") or "Familiar Lector").strip()
            author_email = (body.get("authorEmail") or "").strip()
            member_id = (body.get("memberId") or "").strip()
            category = (body.get("category") or "Sugerencia").strip()
            message = (body.get("message") or "").strip()

            if not message:
                return self._send_json({"ok": False, "error": "El mensaje no puede estar vacío."}, 400)

            data = load_family_data()
            member_obj = next((m for m in data.get("members", []) if m.get("id") == member_id), None)
            comment_obj = {
                "id": f"cmt-{int(time.time() * 1000)}",
                "authorName": author_name,
                "authorEmail": author_email,
                "memberId": member_id,
                "memberName": member_obj["name"] if member_obj else "General del árbol",
                "category": category,
                "message": message,
                "status": "pending",
                "createdAt": now_str(),
            }
            data.setdefault("readerComments", []).insert(0, comment_obj)
            add_history_entry(
                data,
                author_email or author_name,
                "comment_added",
                f"Dejó sugerencia ({category}) sobre {comment_obj['memberName']}",
                message[:120],
            )
            save_family_data(data)
            return self._send_json(
                {"ok": True, "comment": comment_obj, "readerComments": data.get("readerComments", [])}
            )

        # 9. Resolver o descartar comentarios de lectores (Solo Propietario o Co-editor)
        if parsed.path == "/api/family/comments/resolve":
            body = self._read_body_json()
            user_email = (body.get("userEmail") or "").strip().lower()
            comment_id = body.get("commentId")
            action = body.get("action") or "resolved"  # 'resolved' | 'dismiss'

            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json(
                    {"ok": False, "error": "Solo editores y co-editores pueden gestionar sugerencias."},
                    403,
                )

            comments = data.get("readerComments", [])
            if action == "dismiss":
                data["readerComments"] = [c for c in comments if c.get("id") != comment_id]
            else:
                for c in comments:
                    if c.get("id") == comment_id:
                        c["status"] = "resolved"
                        c["resolvedBy"] = user_email
                        c["resolvedAt"] = now_str()
            save_family_data(data)
            return self._send_json({"ok": True, "readerComments": data.get("readerComments", [])})

        # 10. Verificación alternativa con Código de Invitación / PIN (sin cuenta de Google)
        if parsed.path == "/api/family/auth-code":
            body = self._read_body_json()
            code = (body.get("code") or "").strip().upper()
            name = (body.get("name") or "").strip() or "Familiar Invitado"
            if not code:
                return self._send_json({"ok": False, "error": "Ingresá un código familiar o PIN."}, 400)

            data = load_family_data()
            codes = data.get("metadata", {}).get("accessCodes", [])
            found = next((c for c in codes if (c.get("code") or "").strip().upper() == code), None)
            if not found:
                return self._send_json(
                    {"ok": False, "error": "Código o PIN inválido. Pedí un código al propietario o co-editor."},
                    401,
                )

            return self._send_json(
                {
                    "ok": True,
                    "sessionId": f"codigo:{found['code']}",
                    "displayName": name,
                    "role": found.get("role") or "Lector",
                    "label": found.get("label") or "Código Familiar",
                }
            )

        # 11. Gestión de Códigos de Invitación para parientes sin Google (Solo Propietario / Co-editor)
        if parsed.path == "/api/family/access-codes":
            body = self._read_body_json()
            user_email = (body.get("userEmail") or "").strip().lower()
            action = body.get("action") or "create"  # 'create' | 'delete'
            data = load_family_data()
            role = get_user_role(data, user_email)
            if role not in ("Propietario", "Co-editor"):
                return self._send_json({"ok": False, "error": "Sin permisos administrativos."}, 403)

            meta = data.setdefault("metadata", {})
            codes = meta.setdefault("accessCodes", [])

            if action == "delete":
                target_code = (body.get("code") or "").strip().upper()
                meta["accessCodes"] = [c for c in codes if (c.get("code") or "").strip().upper() != target_code]
            else:
                new_code = (body.get("code") or "").strip().upper()
                label = (body.get("label") or "Familiar sin Google").strip()
                target_role = body.get("role") or "Lector"
                if target_role == "Co-editor" and role != "Propietario":
                    target_role = "Lector"
                if not new_code:
                    return self._send_json({"ok": False, "error": "Código vacío."}, 400)
                if not any((c.get("code") or "").strip().upper() == new_code for c in codes):
                    codes.append(
                        {
                            "code": new_code,
                            "label": label,
                            "role": target_role,
                            "createdBy": user_email,
                            "createdAt": now_str(),
                        }
                    )

            add_history_entry(
                data,
                user_email,
                "permissions_changed",
                f"{'Eliminó' if action == 'delete' else 'Creó'} código de acceso familiar ({body.get('code', '')})",
            )
            save_family_data(data)
            return self._send_json({"ok": True, "accessCodes": meta["accessCodes"], "historyLog": data.get("historyLog", [])})

        return self._send_json({"ok": False, "error": "Ruta no encontrada"}, 404)


def get_local_ip():
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True, timeout=2).strip()
        for ip in out.split():
            if not ip.startswith("127.") and ":" not in ip:
                return ip
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    local_ip = get_local_ip()
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("0.0.0.0", PORT), FamilyTreeHandler)
    print("=" * 64)
    print("🌳 ÁRBOL GENEALÓGICO INTERACTIVO - SERVIDOR LOCAL ACTIVO")
    print("=" * 64)
    print(f"👉 En esta computadora:   http://localhost:{PORT}")
    print(f"📱 En tu celular (Wi-Fi): http://{local_ip}:{PORT}")
    print("=" * 64)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
