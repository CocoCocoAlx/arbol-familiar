#!/usr/bin/env python3
"""
Servidor local para el prototipo del Árbol Genealógico Interactivo ("Lienzo Familiar").
Ejecutar con: python3 server.py
Puerto por defecto: 8765
"""

import base64
import json
import os
import re
import socket
import subprocess
import time
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
UPLOADS_DIR = PUBLIC_DIR / "uploads"
DATA_FILE = BASE_DIR / "data" / "familia.json"
STATE_FILE = BASE_DIR / "data" / "familia_estado.json"
PORT = int(os.environ.get("PORT", 8765))


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


def load_family_data():
    """Carga el archivo de estado si existe, o el archivo base original."""
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        base_data = json.load(f)

    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state_data = json.load(f)
            meta = base_data.get("metadata", {})
            meta.update(state_data.get("metadata", {}))
            state_data["metadata"] = meta
            state_data.setdefault("pendingApprovals", [])
            state_data.setdefault("historyLog", default_history())
            return state_data
        except Exception:
            pass

    base_data.setdefault("pendingApprovals", [])
    base_data.setdefault("historyLog", default_history())
    return base_data


def save_family_data(data):
    """Guarda todos los cambios (parientes, posiciones, permisos, validaciones e historial) localmente."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


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


def tidy_family_layout(members):
    """
    Reordena geométricamente las tarjetas de TODOS los familiares actuales (incluyendo los nuevos)
    por nivel generacional, rama y pareja, SIN borrar ningún pariente ni archivo.
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
            visited.add(m["id"])
            ordered_row.append(m)
            sp_id = m.get("spouseId")
            if sp_id and sp_id in by_id and sp_id not in visited:
                sp = by_id[sp_id]
                if int(sp.get("generation", 1)) == gen:
                    visited.add(sp_id)
                    ordered_row.append(sp)

        # Distribuir horizontalmente de forma simétrica y prolija
        cur_x = 140
        for idx, m in enumerate(ordered_row):
            m["x"] = cur_x
            m["y"] = row_y
            # Si el siguiente es su pareja, dejar espacio corto de matrimonio (270px); si no, espacio amplio (340px)
            if idx + 1 < len(ordered_row) and m.get("spouseId") == ordered_row[idx + 1]["id"]:
                cur_x += 275
            else:
                cur_x += 345

    return members


def remove_member_from_tree(data, target_id):
    members = data.get("members", [])
    target = next((m for m in members if m.get("id") == target_id), None)
    if not target:
        return None
    data["members"] = [m for m in members if m.get("id") != target_id]
    for m in data["members"]:
        if m.get("spouseId") == target_id:
            m["spouseId"] = None
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

    match = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
    if not match:
        return None, 0

    mime_type = match.group(1)
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
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/family":
            data = load_family_data()
            return self._send_json(data)

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

        # 4. Subida unificada de Material al Drive del Propietario / YouTube
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
            youtube_upload = bool(body.get("youtubeUpload", True))
            paper_type = body.get("paperType") or "aged-cream"

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
                paragraphs = [p.strip() for p in description.split("\n") if p.strip()]
                if not paragraphs:
                    paragraphs = [title]
                letter_obj = {
                    "id": f"carta-{int(time.time() * 1000)}",
                    "title": title,
                    "date": year_or_date,
                    "location": "Subida a Google Drive",
                    "paperType": paper_type,
                    "inkColor": "#251e19",
                    "scanImageUrl": local_url,
                    "drivePath": f"{drive_root}/Cartas/{target_member['name']}/{title}.jpg",
                    "driveSizeKB": size_kb or 18,
                    "paragraphs": paragraphs,
                    "uploadedBy": user_email,
                }
                target_member.setdefault("letters", []).append(letter_obj)
                add_history_entry(
                    data,
                    user_email,
                    "media_uploaded",
                    f"Subió carta manuscrita '{title}' ({year_or_date}) y activó lectura de voz",
                    f"Familiar: {target_member['name']} · {len(paragraphs)} párrafo(s)",
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

        # 5. Crear o actualizar un familiar
        if parsed.path == "/api/family/member":
            body = self._read_body_json()
            user_email = body.get("userEmail") or "martin.alvarez@gmail.com"
            data = load_family_data()
            if not can_user_edit(data, user_email):
                return self._send_json({"ok": False, "error": "Sin permiso de edición"}, 403)

            updated_member = body.get("member")
            children_ids = body.get("childrenIds", [])
            if not updated_member or not updated_member.get("id"):
                return self._send_json({"ok": False, "error": "Familiar inválido"}, 400)

            members = data.get("members", [])
            member_id = updated_member["id"]

            replaced = False
            for idx, existing in enumerate(members):
                if existing.get("id") == member_id:
                    members[idx] = updated_member
                    replaced = True
                    break
            if not replaced:
                members.append(updated_member)

            # Sincronizar cónyuge bidireccional
            spouse_id = updated_member.get("spouseId")
            for m in members:
                if m["id"] == member_id:
                    continue
                if spouse_id and m["id"] == spouse_id:
                    m["spouseId"] = member_id
                elif not spouse_id and m.get("spouseId") == member_id:
                    m["spouseId"] = None

            # Sincronizar hijos seleccionados hacia abajo
            if isinstance(children_ids, list) and len(children_ids) > 0:
                for m in members:
                    if m["id"] in children_ids:
                        pids = m.setdefault("parentIds", [])
                        if member_id not in pids:
                            pids.append(member_id)

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
    HTTPServer.allow_reuse_address = True
    server = HTTPServer(("0.0.0.0", PORT), FamilyTreeHandler)
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
