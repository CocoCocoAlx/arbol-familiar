/**
 * Aplicación Frontend Mobile-First - Árbol Genealógico Interactivo ("Lienzo Familiar")
 * Incluye:
 * 0) Diseño Mobile-First con barra superior compacta (1 sola fila), Menú Hamburguesa lateral (☰)
 *    y Panel Deslizable de Familiar con cabecera compacta (80% libre para cartas, voz, fotos y videos).
 * 1) Navegación táctil desbloqueada: arrastrar con 1 dedo en cualquier parte mueve el lienzo por defecto
 *    (✋ Modo Lienzo), con interruptor para mover tarjetas (✥) y pellizco con 2 dedos (Pinch-to-Zoom).
 * 2) Ordenamiento inteligente (↺ Ordenar) que alinea todos los parientes actuales SIN borrar ninguno.
 * 3) Propietario Único + Co-editores + Lectores con botones de íconos responsivos (✏️, ⬆️, ⬇️, 🗑️).
 * 4) Sistema de Validación de Decisiones e Historial detallado de modificaciones.
 * 5) Subida de Fotos, Cartas y Videos al Google Drive del propietario + Switch de precarga en YouTube.
 */

const state = {
  familyData: null,
  members: [],
  pendingApprovals: [],
  historyLog: [],
  historyFilter: "all",
  selectedMemberId: null,
  activeFilter: "all",
  viewMode: "canvas",
  currentUserEmail: "martin.alvarez@gmail.com",

  // Estado de cámara del lienzo interactivo
  panX: 60,
  panY: 70,
  scale: 0.85,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  pointerDownClientX: 0,
  pointerDownClientY: 0,

  // Modo táctil: false = 1 dedo mueve siempre el lienzo (✋); true = 1 dedo mueve tarjetas (✥)
  allowCardDrag: false,
  tappedNodeId: null,

  // Estado de arrastre de tarjetas (nodos)
  draggingNodeId: null,
  nodeDragOffsetX: 0,
  nodeDragOffsetY: 0,
  nodeMoved: false,
  dragRafId: null,

  // Estado Pinch-to-Zoom multitáctil (2 dedos)
  isPinching: false,
  pinchStartDist: 0,
  pinchStartScale: 1,
  pinchMidX: 0,
  pinchMidY: 0,

  // Estado del reproductor de voz en español
  speakingLetterId: null,
  speechTimer: null,
  waveInterval: null,
  currentAudio: null,
  cursiveMode: true,

  // Archivo temporal seleccionado en el modal de subida
  pendingUploadDataUrl: null
};

const NODE_WIDTH = 235;
const NODE_HEIGHT = 122;

const GENERATION_NAMES = {
  "-2": "NIVEL -2 · TATARA-TATARABUELOS",
  "-1": "NIVEL -1 · TATARABUELOS (Raíces Históricas)",
  "0": "NIVEL 0 · BISABUELOS",
  "1": "1ª GENERACIÓN · LOS ABUELOS",
  "2": "2ª GENERACIÓN · PADRES Y TÍOS",
  "3": "3ª GENERACIÓN · HERMANOS Y PRIMOS",
  "4": "4ª GENERACIÓN · HIJOS Y SOBRINOS",
  "5": "5ª GENERACIÓN · NIETOS",
  "6": "6ª GENERACIÓN · BISNIETOS"
};

document.addEventListener("DOMContentLoaded", async () => {
  registerServiceWorker();
  setupAuthEvents();
  setupSidebarAndToolbarEvents();
  setupCanvasInteractions();
  setupDrawerEvents();
  setupPermissionsModal();
  setupApprovalsModal();
  setupHistoryModal();
  setupUploadModal();
  setupMemberModal();

  await fetchFamilyTree();
  updateRoleUI();
  updateTouchModeUI();
  fitTreeToScreen(false);
});

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function nowFormatted() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHTML(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getMemberVoiceConfig(member) {
  const cfg = (member && member.voiceProfile) || {};
  const espeakVoice = cfg.espeakVoice || cfg.preset || "es-419+m1";
  const rawSpeed = Number(cfg.espeakSpeed || cfg.rate || 138);
  const espeakSpeed = rawSpeed < 10 ? Math.round(rawSpeed * 140) : Math.round(rawSpeed);
  const rawPitch = Number(cfg.espeakPitch || cfg.pitch || 48);
  const espeakPitch = rawPitch < 10 ? Math.round(rawPitch * 48) : Math.max(25, Math.min(75, Math.round(rawPitch)));
  return {
    espeakVoice,
    espeakSpeed,
    espeakPitch,
    label: cfg.label || `Voz en español de ${member?.name || "Familiar"}`,
    sampleSource: cfg.sampleSource || cfg.timbreDescription || "Síntesis de voz familiar"
  };
}

function addLocalHistoryEntry(category, summary, details = "") {
  const role = isCurrentUserOwner() ? "Propietario" : canCurrentUserEdit() ? "Co-editor" : "Lector";
  state.historyLog.unshift({
    id: `log-${Date.now()}`,
    timestamp: nowFormatted(),
    actorEmail: state.currentUserEmail,
    actorRole: role,
    category,
    summary,
    details
  });
}

/* ==========================================================================
   PERMISOS: PROPIETARIO ÚNICO, CO-EDITORES Y VISITANTES (SOLO LECTURA)
   ========================================================================== */
function getMetadata() {
  if (!state.familyData) state.familyData = { metadata: {} };
  if (!state.familyData.metadata) state.familyData.metadata = {};
  const meta = state.familyData.metadata;
  if (!meta.ownerEmail) meta.ownerEmail = "martin.alvarez@gmail.com";
  if (!Array.isArray(meta.coEditors)) meta.coEditors = ["elena.conti@gmail.com"];
  if (!Array.isArray(meta.allowedEmails)) {
    meta.allowedEmails = [
      "martin.alvarez@gmail.com",
      "elena.conti@gmail.com",
      "lucia.alvarez@gmail.com",
      "roberto.alvarez@gmail.com",
      "marta.alvarez@gmail.com",
      "jorge.conti@gmail.com",
      "invitado.familiar@gmail.com"
    ];
  }
  return meta;
}

function isCurrentUserOwner() {
  const meta = getMetadata();
  return state.currentUserEmail.toLowerCase() === meta.ownerEmail.toLowerCase();
}

function canCurrentUserEdit() {
  const meta = getMetadata();
  const email = state.currentUserEmail.toLowerCase();
  if (email === meta.ownerEmail.toLowerCase()) return true;
  return meta.coEditors.some((ce) => ce.toLowerCase() === email);
}

function getUserRoleLabel(email) {
  const meta = getMetadata();
  const clean = (email || "").toLowerCase();
  if (clean === meta.ownerEmail.toLowerCase()) return "👑 Propietario";
  if (meta.coEditors.some((ce) => ce.toLowerCase() === clean)) return "✍️ Co-editor";
  return "👁️ Lector";
}

function updateRoleUI() {
  const canEdit = canCurrentUserEdit();
  const isOwner = isCurrentUserOwner();
  const roleBadge = document.getElementById("role-status-badge");
  const editorGroup = document.getElementById("editor-actions-group");
  const editorQuickIcons = document.getElementById("editor-quick-icons");
  const drawerEditBox = document.getElementById("drawer-edit-actions");
  const roleTag = document.getElementById("user-role-tag");
  const emailLabel = document.getElementById("user-email-label");
  const approvalsBtn = document.getElementById("btn-open-approvals");
  const approvalsBadge = document.getElementById("approvals-count-badge");
  const hamburgerBadge = document.getElementById("hamburger-badge");
  const touchModeBtn = document.getElementById("btn-toggle-touch-mode");

  if (!canEdit && state.allowCardDrag) {
    state.allowCardDrag = false;
    updateTouchModeUI();
  }

  if (emailLabel) emailLabel.textContent = state.currentUserEmail;
  if (roleTag) {
    roleTag.textContent = isOwner ? "👑 Propietario" : canEdit ? "✍️ Co-editor" : "👁️ Solo Lectura";
  }

  if (roleBadge) {
    if (isOwner) {
      roleBadge.textContent = "👑 Editor";
      roleBadge.title = "Modo Edición (Propietario Único)";
    } else if (canEdit) {
      roleBadge.textContent = "✍️ Co-editor";
      roleBadge.title = "Modo Edición (Co-editor)";
    } else {
      roleBadge.textContent = "👁️ Lectura";
      roleBadge.title = "Modo Solo Lectura";
    }
  }

  if (editorGroup) editorGroup.classList.toggle("hidden", !canEdit);
  if (editorQuickIcons) editorQuickIcons.classList.toggle("hidden", !canEdit);
  if (drawerEditBox) drawerEditBox.classList.toggle("hidden", !canEdit);
  if (touchModeBtn) touchModeBtn.classList.toggle("hidden", !canEdit);

  const pendingCount = (state.pendingApprovals || []).length;
  if (approvalsBadge) {
    approvalsBadge.textContent = pendingCount;
    approvalsBadge.style.background = pendingCount > 0 ? "#d94b38" : "#e9dfd0";
    approvalsBadge.style.color = pendingCount > 0 ? "#fff" : "var(--ink-primary)";
  }
  if (approvalsBtn) {
    approvalsBtn.style.borderColor = pendingCount > 0 ? "#d94b38" : "var(--border-soft)";
  }
  if (hamburgerBadge) {
    hamburgerBadge.classList.toggle("hidden", pendingCount === 0);
  }

  renderAuthSelectOptions();
  renderSidebarRoleSwitcher();
}

function renderAuthSelectOptions() {
  const select = document.getElementById("auth-email-select");
  if (!select) return;
  const meta = getMetadata();
  const owner = meta.ownerEmail;
  const coEditors = meta.coEditors || [];
  const viewers = (meta.allowedEmails || []).filter(
    (e) => e.toLowerCase() !== owner.toLowerCase() && !coEditors.some((c) => c.toLowerCase() === e.toLowerCase())
  );

  let html = `<option value="${owner}">👑 ${owner} (Propietario)</option>`;
  coEditors.forEach((ce) => {
    html += `<option value="${ce}">✍️ ${ce} (Co-editor)</option>`;
  });
  viewers.forEach((vw) => {
    html += `<option value="${vw}">👁️ ${vw} (Solo Lectura)</option>`;
  });
  html += `<option value="desconocido@gmail.com">⛔ desconocido@gmail.com (No autorizado)</option>`;
  select.innerHTML = html;
  if ([owner, ...coEditors, ...viewers].includes(state.currentUserEmail)) {
    select.value = state.currentUserEmail;
  }
}

function renderSidebarRoleSwitcher() {
  const sidebarSwitcher = document.getElementById("sidebar-role-switcher");
  if (!sidebarSwitcher) return;
  const meta = getMetadata();
  const allUsers = Array.from(new Set([meta.ownerEmail, ...(meta.coEditors || []), ...(meta.allowedEmails || [])]));
  sidebarSwitcher.innerHTML = allUsers
    .map((u) => `<option value="${u}" ${u === state.currentUserEmail ? "selected" : ""}>${getUserRoleLabel(u)} · ${u}</option>`)
    .join("");
}

async function fetchFamilyTree() {
  try {
    const res = await fetch("/api/family");
    if (!res.ok) throw new Error("API local no disponible");
    const data = await res.json();
    state.familyData = data;
    state.members = data.members || [];
    state.pendingApprovals = data.pendingApprovals || [];
    state.historyLog = data.historyLog || [];
    ensurePositiveCanvasCoordinates();
    renderAll();
  } catch (err) {
    if (window.FALLBACK_FAMILY_DATA) {
      state.familyData = JSON.parse(JSON.stringify(window.FALLBACK_FAMILY_DATA));
      state.members = state.familyData.members || [];
      state.pendingApprovals = state.familyData.pendingApprovals || [];
      state.historyLog = state.familyData.historyLog || [
        {
          id: "log-init-1",
          timestamp: nowFormatted(),
          actorEmail: "martin.alvarez@gmail.com",
          actorRole: "Propietario",
          category: "permissions_changed",
          summary: "Creó el lienzo familiar y designó a elena.conti@gmail.com como Co-editora",
          details: "12 integrantes iniciales cargados en 3 generaciones"
        }
      ];
      ensurePositiveCanvasCoordinates();
      renderAll();
    } else {
      showToast("Cargando árbol desde caché local...");
    }
  }
}

function renderAll() {
  renderGenerationBands();
  renderNodes();
  renderConnections();
  renderMinimap();
  renderCompactListView();
  updateMemberCountBadge();
  updateRoleUI();
}

function updateMemberCountBadge() {
  const badge = document.getElementById("member-count-badge");
  if (badge) {
    badge.textContent = `${state.members.length}`;
  }
}

/* ==========================================================================
   ORDENAMIENTO GEOMÉTRICO DEL LIENZO SIN BORRAR PARIENTES NUEVOS
   ========================================================================== */
function getMemberPartnerships(member) {
  if (!member) return [];
  if (Array.isArray(member.partnerships) && member.partnerships.length > 0) {
    return member.partnerships
      .filter((p) => p && p.partnerId)
      .map((p, idx) => ({
        partnerId: p.partnerId,
        order: Number(p.order || idx + 1),
        status: p.status || "current",
        period: p.period || ""
      }));
  }
  if (member.spouseId) {
    return [
      {
        partnerId: member.spouseId,
        order: 1,
        status: "current",
        period: ""
      }
    ];
  }
  return [];
}

function arePartnersLinked(m1, m2) {
  if (!m1 || !m2) return false;
  return (
    getMemberPartnerships(m1).some((p) => p.partnerId === m2.id) ||
    getMemberPartnerships(m2).some((p) => p.partnerId === m1.id)
  );
}

function tidyLayoutLocally() {
  if (!state.members || state.members.length === 0) return;

  const gens = Array.from(new Set(state.members.map((m) => Number(m.generation ?? 1)))).sort((a, b) => a - b);
  const byId = Object.fromEntries(state.members.map((m) => [m.id, m]));
  const branchOrder = { paterna: 0, ambas: 1, materna: 2 };

  gens.forEach((gen, rowIdx) => {
    const rowY = 110 + rowIdx * 270;
    const rowMembers = state.members
      .filter((m) => Number(m.generation ?? 1) === gen)
      .sort((a, b) => {
        const ba = branchOrder[a.branch || "paterna"] ?? 1;
        const bb = branchOrder[b.branch || "paterna"] ?? 1;
        if (ba !== bb) return ba - bb;
        return (a.x || 0) - (b.x || 0);
      });

    const orderedRow = [];
    const visited = new Set();

    rowMembers.forEach((m) => {
      if (visited.has(m.id)) return;
      const mParts = getMemberPartnerships(m);
      let hub = m;
      if (mParts.length === 1) {
        const other = byId[mParts[0].partnerId];
        if (
          other &&
          Number(other.generation ?? 1) === gen &&
          !visited.has(other.id) &&
          getMemberPartnerships(other).length > 1
        ) {
          hub = other;
        }
      }

      const hubParts = [...getMemberPartnerships(hub)].sort((a, b) => (a.order || 1) - (b.order || 1));
      if (hubParts.length > 1) {
        const leftPartners = hubParts.filter((p) => p.status === "previous" || p.status === "deceased");
        const rightPartners = hubParts.filter((p) => p.status !== "previous" && p.status !== "deceased");

        leftPartners.forEach((p) => {
          const sp = byId[p.partnerId];
          if (sp && !visited.has(sp.id) && Number(sp.generation ?? 1) === gen) {
            visited.add(sp.id);
            orderedRow.push(sp);
          }
        });
        if (!visited.has(hub.id)) {
          visited.add(hub.id);
          orderedRow.push(hub);
        }
        rightPartners.forEach((p) => {
          const sp = byId[p.partnerId];
          if (sp && !visited.has(sp.id) && Number(sp.generation ?? 1) === gen) {
            visited.add(sp.id);
            orderedRow.push(sp);
          }
        });
      } else {
        visited.add(m.id);
        orderedRow.push(m);
        if (mParts.length === 1) {
          const sp = byId[mParts[0].partnerId];
          if (sp && !visited.has(sp.id) && Number(sp.generation ?? 1) === gen) {
            visited.add(sp.id);
            orderedRow.push(sp);
          }
        }
      }
    });

    const hasParentsInTree =
      rowIdx > 0 &&
      orderedRow.some((m) => (m.parentIds || []).some((pid) => Boolean(byId[pid])));

    if (hasParentsInTree) {
      const groups = [];
      let idx = 0;
      while (idx < orderedRow.length) {
        const curr = orderedRow[idx];
        const pidsKey = (curr.parentIds || [])
          .filter((pid) => Boolean(byId[pid]))
          .sort()
          .join("--");
        const grp = [curr];
        idx++;
        while (idx < orderedRow.length) {
          const nxt = orderedRow[idx];
          const nxtKey = (nxt.parentIds || [])
            .filter((pid) => Boolean(byId[pid]))
            .sort()
            .join("--");
          if (pidsKey && nxtKey === pidsKey) {
            grp.push(nxt);
            idx++;
          } else if (arePartnersLinked(grp[grp.length - 1], nxt)) {
            grp.push(nxt);
            idx++;
          } else {
            break;
          }
        }
        groups.push({ pidsKey, grp });
      }

      let minNextX = 100;
      groups.forEach(({ pidsKey, grp }) => {
        const step = 295;
        const grpSpan = (grp.length - 1) * step;
        let startX = minNextX;
        if (pidsKey) {
          const pids = pidsKey.split("--").filter(Boolean);
          const parentXs = pids.map((pid) => byId[pid]?.x ?? 200);
          const centerX = parentXs.reduce((a, b) => a + b, 0) / parentXs.length;
          startX = Math.round(centerX - grpSpan / 2);
        }
        startX = Math.max(minNextX, startX);
        grp.forEach((memberItem, i) => {
          memberItem.x = startX + i * step;
          memberItem.y = rowY;
        });
        minNextX = startX + grpSpan + 335;
      });
    } else {
      let curX = orderedRow.length > 5 ? 100 : 240;
      orderedRow.forEach((m, idx) => {
        m.x = curX;
        m.y = rowY;
        if (idx + 1 < orderedRow.length && arePartnersLinked(m, orderedRow[idx + 1])) {
          curX += 295;
        } else {
          curX += 355;
        }
      });
    }
  });
}

/* ==========================================================================
   SUBNIVELES GENERACIONALES DINÁMICOS (TATARABUELOS A BISNIETOS)
   ========================================================================== */
function getGenerationLabel(gen) {
  const key = String(gen);
  if (GENERATION_NAMES[key]) return GENERATION_NAMES[key];
  if (gen < -2) return `NIVEL ${gen} · ANCESTROS REMOTOS`;
  return `GENERACIÓN ${gen} · DESCENDIENTES`;
}

function ensurePositiveCanvasCoordinates() {
  if (state.members.length === 0) return;
  const minY = Math.min(...state.members.map((m) => m.y));
  if (minY < 75) {
    const shiftY = 100 - minY;
    state.members.forEach((m) => {
      m.y += shiftY;
    });
  }
}

function getIdealYForGeneration(targetGen) {
  const sameGen = state.members.filter((m) => Number(m.generation) === Number(targetGen));
  if (sameGen.length > 0) {
    return sameGen[0].y;
  }
  const refMember = state.members[0];
  if (!refMember) return 110 + (targetGen - 1) * 270;
  const diffGen = targetGen - Number(refMember.generation || 1);
  return refMember.y + diffGen * 270;
}

function renderGenerationBands() {
  const container = document.getElementById("gen-bands-layer");
  if (!container) return;

  const gensMap = new Map();
  state.members.forEach((m) => {
    const g = Number(m.generation ?? 1);
    if (!gensMap.has(g)) {
      gensMap.set(g, []);
    }
    gensMap.get(g).push(m.y);
  });

  const sortedGens = Array.from(gensMap.keys()).sort((a, b) => a - b);
  const maxX = Math.max(1500, ...state.members.map((m) => m.x + 320));

  container.innerHTML = sortedGens
    .map((g) => {
      const ys = gensMap.get(g);
      const minY = Math.min(...ys);
      const bandTop = Math.max(16, minY - 58);
      return `
        <div class="gen-band" style="top: ${bandTop}px; width: ${maxX}px;">
          <span class="gen-tag">${getGenerationLabel(g)}</span>
        </div>
      `;
    })
    .join("");
}

/* ==========================================================================
   ILUSTRACIONES SVG ULTRALIGERAS (RETRATOS Y FOTOS DE ÉPOCA)
   ========================================================================== */
function renderPortraitSVG(member) {
  const bg = escapeHTML(member.avatarColor || "#8C5A3C");
  const initials = escapeHTML(member.avatarInitials || (member.name || "").slice(0, 2).toUpperCase());
  const isElder = Number(member.generation) <= 1;
  const hairColor = isElder ? "#d9d2c5" : "#3d2b1f";

  return `
    <svg viewBox="0 0 80 80" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect width="80" height="80" fill="${bg}" />
      <circle cx="40" cy="40" r="36" fill="rgba(255,255,255,0.08)" />
      <path d="M14 78 C16 58, 64 58, 66 78 Z" fill="rgba(25,18,14,0.38)" />
      <circle cx="40" cy="34" r="15" fill="#f1d2b6" />
      <path d="M25 32 C25 18, 55 18, 55 32 C52 24, 28 24, 25 32 Z" fill="${hairColor}" />
      <rect x="4" y="4" width="24" height="16" rx="4" fill="rgba(0,0,0,0.32)" />
      <text x="16" y="15" text-anchor="middle" fill="#fff" font-size="9" font-weight="bold" font-family="sans-serif">${initials}</text>
    </svg>
  `;
}

function renderVintagePhotoSVG(photo, member) {
  return `
    <svg viewBox="0 0 400 220" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sepia-${escapeHTML(photo.id)}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#e8d8be" />
          <stop offset="100%" stop-color="#bfa582" />
        </linearGradient>
      </defs>
      <rect width="400" height="220" fill="url(#sepia-${escapeHTML(photo.id)})" />
      <rect x="14" y="14" width="372" height="192" fill="none" stroke="#6e563a" stroke-width="1.5" stroke-dasharray="4 3" />
      <circle cx="135" cy="95" r="26" fill="#7c6244" opacity="0.55" />
      <path d="M90 185 C95 135, 175 135, 180 185 Z" fill="#634c32" opacity="0.65" />
      <rect x="215" y="65" width="120" height="85" rx="6" fill="#8c7150" opacity="0.35" stroke="#5b452d" stroke-width="2" />
      <text x="275" y="105" text-anchor="middle" fill="#473521" font-family="Georgia, serif" font-size="13" font-style="italic">
        Archivo ${escapeHTML(photo.year)}
      </text>
      <text x="275" y="125" text-anchor="middle" fill="#5b452d" font-family="sans-serif" font-size="11" font-weight="bold">
        ${escapeHTML(member.name)}
      </text>
      <text x="26" y="196" fill="#4a3826" font-family="Georgia, serif" font-size="11">
        ☁️ Google Drive · Miniatura optimizada (${escapeHTML(photo.sizeKB || 14)} KB)
      </text>
    </svg>
  `;
}

/* ==========================================================================
   RENDERIZADO DE NODOS Y CURVAS BÉZIER EN EL LIENZO
   ========================================================================== */
function matchesFilter(member) {
  if (state.activeFilter === "all") return true;
  if (state.activeFilter === "paterna") return member.branch === "paterna" || member.branch === "ambas";
  if (state.activeFilter === "materna") return member.branch === "materna" || member.branch === "ambas";
  if (state.activeFilter === "letters") return member.letters && member.letters.length > 0;
  return true;
}

function renderNodes() {
  const layer = document.getElementById("nodes-layer");
  layer.innerHTML = "";

  const byId = Object.fromEntries(state.members.map((m) => [m.id, m]));
  const pendingDeleteIds = new Set(
    (state.pendingApprovals || []).map((r) => r.targetMemberId)
  );

  state.members.forEach((member) => {
    const card = document.createElement("div");
    card.className = "family-node";
    if (member.id === state.selectedMemberId) card.classList.add("selected");
    if (!matchesFilter(member)) card.classList.add("dimmed");

    const partnerships = getMemberPartnerships(member);
    const isOnlyExPartner =
      partnerships.length === 1 && partnerships[0].status === "previous";
    const isOnlyDeceasedPartner =
      partnerships.length === 1 &&
      partnerships[0].status === "deceased" &&
      member.deathYear &&
      member.deathYear !== "Presente";

    if (isOnlyExPartner) card.classList.add("is-ex-partner");
    if (isOnlyDeceasedPartner) card.classList.add("is-deceased-partner");

    card.style.left = `${member.x}px`;
    card.style.top = `${member.y}px`;
    card.dataset.id = member.id;

    const lettersCount = (member.letters || []).length;
    const photosCount = (member.photos || []).length;
    const videosCount = (member.videos || []).length;

    let badgesHTML = "";
    if (partnerships.length >= 2) {
      badgesHTML += `<span class="nupcias-pill multi" title="Persona con ${partnerships.length} uniones/nupcias registradas">💍 ${partnerships.length} nupcias</span>`;
    } else if (partnerships.length === 1) {
      const p = partnerships[0];
      const partnerObj = byId[p.partnerId];
      const partnerTotal = partnerObj ? getMemberPartnerships(partnerObj).length : 1;
      const ordPrefix = partnerTotal > 1 || (p.order && p.order > 1) ? `${p.order || 1}ª ` : "";
      if (p.status === "previous") {
        badgesHTML += `<span class="nupcias-pill ex" title="Ex-pareja (${ordPrefix}nupcias)">${ordPrefix}♡ Ex-pareja</span>`;
      } else if (p.status === "deceased") {
        const isDeceasedSelf = member.deathYear && member.deathYear !== "Presente";
        badgesHTML += `<span class="nupcias-pill deceased" title="Unión con cónyuge fallecido/a">${ordPrefix}† ${isDeceasedSelf ? "Cónyuge †" : "Viudo/a"}</span>`;
      } else if (partnerTotal > 1 || (p.order && p.order > 1)) {
        badgesHTML += `<span class="nupcias-pill current" title="Pareja actual en ${p.order || 2}ª nupcias">${p.order || 2}ª ♥ Actual</span>`;
      }
    }

    if (pendingDeleteIds.has(member.id)) {
      badgesHTML += `<span class="media-pill" style="background:#fdeceb;border-color:#f3b7b3;color:#8f2620;">⏳ En revisión</span>`;
    } else if (lettersCount > 0) {
      badgesHTML += `<span class="media-pill has-voice">✉️ ${lettersCount} · 🔊 Voz</span>`;
    } else {
      badgesHTML += `<span class="media-pill">🔊 Voz</span>`;
    }
    if (photosCount > 0) {
      badgesHTML += `<span class="media-pill">📷 ${photosCount}</span>`;
    }
    if (videosCount > 0) {
      badgesHTML += `<span class="media-pill">🎬 ${videosCount}</span>`;
    }

    card.innerHTML = `
      <div class="node-top">
        <div class="node-avatar">${renderPortraitSVG(member)}</div>
        <div class="node-info">
          <span class="node-role-pill">${escapeHTML(member.role)}</span>
          <div class="node-name" title="${escapeHTML(member.name)}">${escapeHTML(member.name)}</div>
          <div class="node-years">${escapeHTML(member.birthYear)} – ${escapeHTML(member.deathYear)}</div>
        </div>
      </div>
      <div class="node-occupation" title="${escapeHTML(member.occupation)}">${escapeHTML(member.occupation)}</div>
      <div class="node-badges">${badgesHTML}</div>
    `;

    layer.appendChild(card);
  });
}

function renderConnections() {
  const svg = document.getElementById("connections-svg");
  const byId = Object.fromEntries(state.members.map((m) => [m.id, m]));
  let pathsHTML = "";

  const drawnUnions = new Set();
  const unionMidpoints = {};

  state.members.forEach((m) => {
    const mParts = getMemberPartnerships(m);
    mParts.forEach((p) => {
      const spouse = byId[p.partnerId];
      if (!spouse) return;

      const pairKey = [m.id, spouse.id].sort().join("--");
      if (drawnUnions.has(pairKey)) return;
      drawnUnions.add(pairKey);

      const spouseParts = getMemberPartnerships(spouse);
      const reciprocal = spouseParts.find((sp) => sp.partnerId === m.id);
      const order = Math.max(Number(p.order || 1), Number(reciprocal?.order || 1));
      const status = p.status || reciprocal?.status || "current";
      const isMultiNupcias = mParts.length > 1 || spouseParts.length > 1 || order > 1;

      const left = m.x <= spouse.x ? m : spouse;
      const right = m.x <= spouse.x ? spouse : m;

      // Detectar si existe otra tarjeta intermedia en la misma fila entre ambos miembros de la pareja
      const hasCardBetween = state.members.some(
        (other) =>
          other.id !== left.id &&
          other.id !== right.id &&
          Math.abs((other.y || 0) - (left.y || 0)) < 80 &&
          other.x > left.x + 40 &&
          other.x < right.x - 40
      );

      let strokeColor = "#b5835a";
      let strokeDash = "";
      let strokeWidth = "2.8";
      let badgeBg = "#fdf0ed";
      let badgeBorder = "#b5835a";
      let badgeInk = "#7c3224";
      let symbol = "♥";

      if (status === "previous") {
        strokeColor = "#8e8276";
        strokeDash = 'stroke-dasharray="5 5"';
        strokeWidth = "2.2";
        badgeBg = "#f2efe9";
        badgeBorder = "#8e8276";
        badgeInk = "#4e463e";
        symbol = "♡";
      } else if (status === "deceased") {
        strokeColor = "#7d6856";
        strokeDash = 'stroke-dasharray="8 4"';
        strokeWidth = "2.3";
        badgeBg = "#efe8df";
        badgeBorder = "#7d6856";
        badgeInk = "#4a3c30";
        symbol = "†";
      }

      const labelText = isMultiNupcias || status !== "current" ? `${order}ª ${symbol}` : symbol;
      const pillWidth = labelText.length > 2 ? 44 : 26;
      const pillHeight = 20;

      let midX, midY;
      let childOriginX, childOriginY;

      if (!hasCardBetween) {
        const x1 = left.x + NODE_WIDTH;
        const y1 = left.y + NODE_HEIGHT / 2;
        const x2 = right.x;
        const y2 = right.y + NODE_HEIGHT / 2;
        midX = (x1 + x2) / 2;
        midY = (y1 + y2) / 2;
        childOriginX = midX;
        childOriginY = midY;

        pathsHTML += `
          <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
                stroke="${strokeColor}" stroke-width="${strokeWidth}" ${strokeDash} />
        `;
      } else {
        // Si hay una tarjeta en el medio, trazar un arco superior limpio para no cruzar la tarjeta central
        const x1 = left.x + NODE_WIDTH / 2;
        const y1 = left.y;
        const x2 = right.x + NODE_WIDTH / 2;
        const y2 = right.y;
        midX = (x1 + x2) / 2;
        const ctrlY = Math.min(y1, y2) - 48;
        midY = 0.25 * y1 + 0.5 * ctrlY + 0.25 * y2;
        childOriginX = midX;
        childOriginY = Math.max(left.y, right.y) + NODE_HEIGHT / 2;

        pathsHTML += `
          <path d="M ${x1} ${y1} Q ${midX} ${ctrlY} ${x2} ${y2}"
                fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" ${strokeDash} />
        `;
      }

      unionMidpoints[pairKey] = { x: childOriginX, y: childOriginY, status };

      // Ubicar el rectángulo redondeado POR ENCIMA de la línea para dejar la línea 100% libre y visible
      const badgeCenterY = midY - 19;
      pathsHTML += `
        <rect x="${midX - pillWidth / 2}" y="${badgeCenterY - pillHeight / 2}" width="${pillWidth}" height="${pillHeight}" rx="6"
              fill="${badgeBg}" stroke="${badgeBorder}" stroke-width="1.5" />
        <text x="${midX}" y="${badgeCenterY + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="${badgeInk}">
          ${labelText}
        </text>
      `;
    });
  });

  state.members.forEach((child) => {
    const parents = (child.parentIds || []).map((pid) => byId[pid]).filter(Boolean);
    if (parents.length === 0) return;

    let originX, originY;
    if (parents.length >= 2) {
      const p1 = parents[0];
      const p2 = parents[1];
      const pairKey = [p1.id, p2.id].sort().join("--");
      if (unionMidpoints[pairKey]) {
        originX = unionMidpoints[pairKey].x;
        originY = unionMidpoints[pairKey].y;
      } else {
        originX = (p1.x + p2.x + NODE_WIDTH) / 2;
        originY = (p1.y + p2.y + NODE_HEIGHT) / 2;
      }
    } else {
      originX = parents[0].x + NODE_WIDTH / 2;
      originY = parents[0].y + NODE_HEIGHT;
    }

    const targetX = child.x + NODE_WIDTH / 2;
    const targetY = child.y;
    const ctrlY = originY + (targetY - originY) * 0.52;

    pathsHTML += `
      <path d="M ${originX} ${originY} C ${originX} ${ctrlY}, ${targetX} ${ctrlY}, ${targetX} ${targetY}"
            fill="none" stroke="#8c6d53" stroke-width="2.4" stroke-linecap="round" opacity="0.82" />
      <circle cx="${originX}" cy="${originY}" r="3.2" fill="#8c6d53" />
      <circle cx="${targetX}" cy="${targetY}" r="4" fill="#8c4f30" />
    `;
  });

  svg.innerHTML = pathsHTML;
}

/* ==========================================================================
   INTERACCIÓN DEL LIENZO TÁCTIL Y ESCRITORIO (PAN DESBLOQUEADO + PINCH ZOOM)
   ========================================================================== */
function updateTouchModeUI() {
  const pillBtn = document.getElementById("btn-toggle-touch-mode");
  const iconEl = document.getElementById("touch-mode-icon");
  const textEl = document.getElementById("touch-mode-text");
  const sbIcon = document.getElementById("sidebar-drag-icon");
  const sbLabel = document.getElementById("sidebar-drag-label");

  if (state.allowCardDrag) {
    pillBtn?.classList.remove("active-pan");
    pillBtn?.classList.add("active-drag");
    if (iconEl) iconEl.textContent = "✥";
    if (textEl) textEl.textContent = "Mover Tarjetas";
    if (sbIcon) sbIcon.textContent = "✥";
    if (sbLabel) sbLabel.textContent = "Modo: Mover Tarjetas";
  } else {
    pillBtn?.classList.add("active-pan");
    pillBtn?.classList.remove("active-drag");
    if (iconEl) iconEl.textContent = "✋";
    if (textEl) textEl.textContent = "Lienzo";
    if (sbIcon) sbIcon.textContent = "✋";
    if (sbLabel) sbLabel.textContent = "Modo: Mover Mapa";
  }
}

function toggleCardDragMode() {
  if (!canCurrentUserEdit()) {
    showToast("👁️ Solo el Propietario y los Co-editores pueden reubicar tarjetas.");
    return;
  }
  state.allowCardDrag = !state.allowCardDrag;
  updateTouchModeUI();
  showToast(
    state.allowCardDrag
      ? "✥ Modo Mover Tarjetas activado: arrastra cualquier familiar para reubicarlo"
      : "✋ Modo Lienzo activado: desliza con 1 dedo en cualquier parte para recorrer el árbol"
  );
}

function updateCanvasTransform(smooth = false) {
  const world = document.getElementById("canvas-world");
  world.style.transition = smooth ? "transform 0.36s cubic-bezier(0.22, 1, 0.36, 1)" : "none";
  world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;

  const label = document.getElementById("zoom-level-label");
  if (label) label.textContent = `${Math.round(state.scale * 100)}%`;

  renderMinimap();
}

function setupCanvasInteractions() {
  const viewport = document.getElementById("canvas-viewport");

  // Botones para alternar entre Modo Lienzo (✋) y Modo Mover Tarjetas (✥)
  document.getElementById("btn-toggle-touch-mode")?.addEventListener("click", () => {
    toggleCardDragMode();
  });
  document.getElementById("btn-sidebar-toggle-drag")?.addEventListener("click", () => {
    toggleCardDragMode();
    closeSidebarMenu();
  });

  // 1) Eventos Pointer (unificados para táctil y mouse)
  viewport.addEventListener("pointerdown", (e) => {
    if (state.isPinching) return;
    if (e.target.closest(".canvas-hud-bottom") || e.target.closest(".minimap-card")) {
      return;
    }

    state.pointerDownClientX = e.clientX;
    state.pointerDownClientY = e.clientY;
    state.nodeMoved = false;

    const cardEl = e.target.closest(".family-node");
    const memberId = cardEl ? cardEl.dataset.id : null;

    // Si tocó una tarjeta Y está activo el modo de arrastrar tarjetas (✥), arrastramos la tarjeta
    if (memberId && state.allowCardDrag && canCurrentUserEdit()) {
      const member = state.members.find((m) => m.id === memberId);
      if (member) {
        state.draggingNodeId = member.id;
        state.tappedNodeId = member.id;
        state.nodeDragOffsetX = (e.clientX - state.panX) / state.scale - member.x;
        state.nodeDragOffsetY = (e.clientY - state.panY) / state.scale - member.y;
        return;
      }
    }

    // Por defecto (✋ Modo Lienzo): arrastrar en CUALQUIER parte de la pantalla (incluso sobre una tarjeta)
    // mueve el lienzo con suavidad, y un toque corto sobre una tarjeta abre su panel deslizable.
    state.tappedNodeId = memberId;
    state.isPanning = true;
    state.panStartX = e.clientX - state.panX;
    state.panStartY = e.clientY - state.panY;
    viewport.classList.add("dragging-canvas");
  });

  window.addEventListener("pointermove", (e) => {
    if (state.isPinching) return;

    const movedDist = Math.hypot(
      e.clientX - state.pointerDownClientX,
      e.clientY - state.pointerDownClientY
    );
    if (movedDist > 8) {
      state.nodeMoved = true;
    }

    if (state.isPanning) {
      state.panX = e.clientX - state.panStartX;
      state.panY = e.clientY - state.panStartY;
      updateCanvasTransform(false);
      return;
    }

    if (state.draggingNodeId) {
      if (!canCurrentUserEdit()) return;
      const member = state.members.find((m) => m.id === state.draggingNodeId);
      if (!member) return;

      const newX = (e.clientX - state.panX) / state.scale - state.nodeDragOffsetX;
      const newY = (e.clientY - state.panY) / state.scale - state.nodeDragOffsetY;

      member.x = Math.max(20, Math.min(2400, newX));
      member.y = Math.max(20, Math.min(2000, newY));

      const card = document.querySelector(`.family-node[data-id="${member.id}"]`);
      if (card) {
        card.style.left = `${member.x}px`;
        card.style.top = `${member.y}px`;
      }
      if (!state.dragRafId) {
        state.dragRafId = requestAnimationFrame(() => {
          state.dragRafId = null;
          renderGenerationBands();
          renderConnections();
          renderMinimap();
        });
      }
    }
  });

  window.addEventListener("pointerup", () => {
    if (state.isPinching) return;

    const wasMoved = state.nodeMoved;
    const tappedId = state.tappedNodeId;
    const draggedId = state.draggingNodeId;

    if (state.isPanning) {
      state.isPanning = false;
      viewport.classList.remove("dragging-canvas");
    }

    state.draggingNodeId = null;
    state.tappedNodeId = null;
    state.nodeMoved = false;

    if (draggedId && wasMoved && canCurrentUserEdit()) {
      saveNodePositions();
      return;
    }

    // Si fue un toque corto (< 8px) sobre un familiar, abrimos su panel deslizable
    if (tappedId && !wasMoved) {
      openMemberDrawer(tappedId);
    }
  });

  // 2) Soporte nativo Pinch-to-Zoom con 2 dedos para celulares
  viewport.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        state.isPinching = true;
        state.isPanning = false;
        state.draggingNodeId = null;
        state.tappedNodeId = null;
        viewport.classList.remove("dragging-canvas");

        const t1 = e.touches[0];
        const t2 = e.touches[1];
        state.pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        state.pinchStartScale = state.scale;

        const rect = viewport.getBoundingClientRect();
        state.pinchMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
        state.pinchMidY = (t1.clientY + t2.clientY) / 2 - rect.top;
      }
    },
    { passive: false }
  );

  viewport.addEventListener(
    "touchmove",
    (e) => {
      if (state.isPinching && e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (state.pinchStartDist < 10) return;

        const factor = dist / state.pinchStartDist;
        const newScale = Math.min(1.75, Math.max(0.32, state.pinchStartScale * factor));

        state.panX = state.pinchMidX - ((state.pinchMidX - state.panX) / state.scale) * newScale;
        state.panY = state.pinchMidY - ((state.pinchMidY - state.panY) / state.scale) * newScale;
        state.scale = newScale;

        updateCanvasTransform(false);
      }
    },
    { passive: false }
  );

  viewport.addEventListener("touchend", (e) => {
    if (state.isPinching && e.touches.length < 2) {
      state.isPinching = false;
    }
  });

  // 3) Zoom con rueda del ratón en escritorio
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.09 : 0.91;
      const newScale = Math.min(1.75, Math.max(0.32, state.scale * zoomFactor));

      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      state.panX = mouseX - ((mouseX - state.panX) / state.scale) * newScale;
      state.panY = mouseY - ((mouseY - state.panY) / state.scale) * newScale;
      state.scale = newScale;

      updateCanvasTransform(false);
    },
    { passive: false }
  );

  document.getElementById("btn-zoom-in")?.addEventListener("click", () => {
    state.scale = Math.min(1.75, state.scale * 1.16);
    updateCanvasTransform(true);
  });
  document.getElementById("btn-zoom-out")?.addEventListener("click", () => {
    state.scale = Math.max(0.32, state.scale * 0.85);
    updateCanvasTransform(true);
  });
  document.getElementById("btn-zoom-fit")?.addEventListener("click", () => fitTreeToScreen(true));
  document.getElementById("btn-brand-center")?.addEventListener("click", () => fitTreeToScreen(true));
}

async function saveNodePositions() {
  if (!canCurrentUserEdit()) return;
  const positions = {};
  state.members.forEach((m) => {
    positions[m.id] = { x: m.x, y: m.y };
  });
  try {
    await fetch("/api/family/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions, userEmail: state.currentUserEmail })
    });
  } catch (_) {}
}

function fitTreeToScreen(smooth = true) {
  if (state.members.length === 0) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight - 52;

  const minX = Math.min(...state.members.map((m) => m.x)) - 35;
  const maxX = Math.max(...state.members.map((m) => m.x + NODE_WIDTH)) + 35;
  const minY = Math.min(...state.members.map((m) => m.y)) - 45;
  const maxY = Math.max(...state.members.map((m) => m.y + NODE_HEIGHT)) + 45;

  const treeW = maxX - minX;
  const treeH = maxY - minY;

  const scaleX = (vw - 28) / treeW;
  const scaleY = (vh - 70) / treeH;
  state.scale = Math.min(1.0, Math.max(0.34, Math.min(scaleX, scaleY)));

  state.panX = (vw - treeW * state.scale) / 2 - minX * state.scale;
  state.panY = 20 + (vh - 60 - treeH * state.scale) / 2 - minY * state.scale;

  updateCanvasTransform(smooth);
}

function flyToMember(memberId) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight - 52;
  const targetScale = vw < 768 ? 0.82 : 1.0;

  state.scale = targetScale;
  const offsetX = vw > 860 ? -160 : 0;
  const offsetY = vw < 768 ? -110 : 0;

  state.panX = vw / 2 - (member.x + NODE_WIDTH / 2) * state.scale + offsetX;
  state.panY = vh / 2 - (member.y + NODE_HEIGHT / 2) * state.scale + offsetY;

  updateCanvasTransform(true);
  openMemberDrawer(memberId);
}

function renderMinimap() {
  const dotsContainer = document.getElementById("minimap-dots");
  const rectEl = document.getElementById("minimap-viewport-rect");
  if (!dotsContainer || !rectEl) return;

  const mapW = 148;
  const mapH = 82;
  const worldW = Math.max(1650, ...state.members.map((m) => m.x + 300));
  const worldH = Math.max(950, ...state.members.map((m) => m.y + 250));

  dotsContainer.innerHTML = state.members
    .map((m) => {
      const left = Math.round((m.x / worldW) * mapW);
      const top = Math.round((m.y / worldH) * mapH);
      const color = m.id === state.selectedMemberId ? "#8c4f30" : "#62564c";
      return `<div class="minimap-dot" style="left:${left}px;top:${top}px;background:${color}"></div>`;
    })
    .join("");

  const vx = Math.max(0, (-state.panX / state.scale / worldW) * mapW);
  const vy = Math.max(0, (-state.panY / state.scale / worldH) * mapH);
  const vw = Math.min(mapW, (window.innerWidth / state.scale / worldW) * mapW);
  const vh = Math.min(mapH, (window.innerHeight / state.scale / worldH) * mapH);

  rectEl.style.left = `${vx}px`;
  rectEl.style.top = `${vy}px`;
  rectEl.style.width = `${vw}px`;
  rectEl.style.height = `${vh}px`;
}

/* ==========================================================================
   PANEL DESLIZABLE DEL FAMILIAR (CABECERA COMPACTA + 80% MULTIMEDIA)
   ========================================================================== */
function openMemberDrawer(memberId) {
  stopVoicePlayback();
  state.selectedMemberId = memberId;
  renderNodes();
  renderMinimap();

  const member = state.members.find((m) => m.id === memberId);
  if (!member) return;

  const drawer = document.getElementById("member-drawer");
  const backdrop = document.getElementById("member-drawer-backdrop");
  drawer.classList.remove("hidden");
  backdrop?.classList.remove("hidden");

  document.getElementById("drawer-portrait").innerHTML = renderPortraitSVG(member);
  document.getElementById("drawer-role").textContent = `${member.role} · Nivel ${member.generation}`;
  document.getElementById("drawer-years").textContent = `${member.birthYear}–${member.deathYear}`;
  document.getElementById("drawer-name").textContent = member.name;
  document.getElementById("drawer-nickname").textContent = `“${member.nickname}” · ${member.occupation}`;

  document.getElementById("bio-birthplace").textContent = member.birthPlace || "—";
  document.getElementById("bio-occupation").textContent = member.occupation || "—";
  document.getElementById("bio-text").textContent = member.bio || "";

  // Mostrar aviso si este familiar tiene una solicitud de eliminación pendiente de validación
  const pendingReq = (state.pendingApprovals || []).find((r) => r.targetMemberId === member.id);
  const alertBox = document.getElementById("drawer-pending-delete-alert");
  if (alertBox) {
    if (pendingReq) {
      alertBox.classList.remove("hidden");
      alertBox.innerHTML = `
        ⏳ <strong>Eliminación en validación:</strong> Solicitada por <em>${escapeHTML(pendingReq.requestedBy)}</em> (${escapeHTML(pendingReq.reason)}).
        ${
          isCurrentUserOwner()
            ? `<div style="margin-top:6px;display:flex;gap:6px;">
                 <button class="btn-primary" style="padding:4px 10px;font-size:11.5px;" id="btn-inline-approve-del">✅ Aprobar</button>
                 <button class="btn-ghost" style="padding:4px 10px;font-size:11.5px;background:#fff;" id="btn-inline-reject-del">❌ Rechazar</button>
               </div>`
            : ""
        }
      `;
      alertBox.querySelector("#btn-inline-approve-del")?.addEventListener("click", () => {
        resolveApprovalRequest(pendingReq.id, "approve");
      });
      alertBox.querySelector("#btn-inline-reject-del")?.addEventListener("click", () => {
        resolveApprovalRequest(pendingReq.id, "reject");
      });
    } else {
      alertBox.classList.add("hidden");
    }
  }

  renderFamilyRelationshipChips(member);

  const milestonesEl = document.getElementById("bio-milestones");
  milestonesEl.innerHTML = (member.milestones || [])
    .map((ms) => `<li><strong>${escapeHTML(ms.year)}:</strong> ${escapeHTML(ms.event)}</li>`)
    .join("");

  const letters = member.letters || [];
  const photos = member.photos || [];
  const videos = member.videos || [];

  document.getElementById("tab-count-letters").textContent = letters.length;
  document.getElementById("tab-count-photos").textContent = photos.length;
  document.getElementById("tab-count-videos").textContent = videos.length;

  updateRoleUI();
  renderMemberLetters(member);
  renderMemberPhotos(member);
  renderMemberVideos(member);
}

function closeMemberDrawer() {
  stopVoicePlayback();
  const drawer = document.getElementById("member-drawer");
  const backdrop = document.getElementById("member-drawer-backdrop");
  drawer?.classList.add("hidden");
  drawer?.classList.remove("expanded-full");
  backdrop?.classList.add("hidden");
  state.selectedMemberId = null;
  renderNodes();
}

function renderFamilyRelationshipChips(member) {
  const container = document.getElementById("bio-family-links");
  const byId = Object.fromEntries(state.members.map((m) => [m.id, m]));
  const chips = [];

  const partnerships = [...getMemberPartnerships(member)].sort(
    (a, b) => (a.order || 1) - (b.order || 1)
  );
  const hasMultipleNupcias = partnerships.length > 1;

  partnerships.forEach((p) => {
    const s = byId[p.partnerId];
    if (!s) return;
    const sParts = getMemberPartnerships(s);
    const showOrder = hasMultipleNupcias || sParts.length > 1 || (p.order && p.order > 1);
    const ordTag = showOrder ? ` (${p.order || 1}ª nupcias)` : "";
    const periodTag = p.period ? ` · ${p.period}` : "";

    if (p.status === "previous") {
      chips.push({
        label: `♡ Ex-pareja${ordTag}: ${s.name}${periodTag}`,
        id: s.id,
        cls: "chip-ex"
      });
    } else if (p.status === "deceased") {
      const isDeceasedPartner = s.deathYear && s.deathYear !== "Presente";
      const roleTxt = isDeceasedPartner ? "Pareja fallecida" : "Cónyuge (viudo/a)";
      chips.push({
        label: `† ${roleTxt}${ordTag}: ${s.name}${periodTag}`,
        id: s.id,
        cls: "chip-deceased"
      });
    } else {
      chips.push({
        label: `♥ Pareja actual${ordTag}: ${s.name}${periodTag}`,
        id: s.id,
        cls: "chip-current"
      });
    }
  });

  (member.parentIds || []).forEach((pid) => {
    if (byId[pid]) chips.push({ label: `⬆️ Padre/Madre: ${byId[pid].name}`, id: pid, cls: "" });
  });

  state.members
    .filter((m) => (m.parentIds || []).includes(member.id))
    .forEach((child) => {
      const coParentId = (child.parentIds || []).find((pid) => pid !== member.id && byId[pid]);
      const coParentTxt = coParentId ? ` (con ${byId[coParentId].name})` : "";
      chips.push({
        label: `⬇️ Hijo/a: ${child.name}${coParentTxt}`,
        id: child.id,
        cls: ""
      });
    });

  if (chips.length === 0) {
    container.innerHTML = `<span style="font-size:12px;color:var(--ink-muted);">Sin vínculos conectados aún.</span>`;
    return;
  }

  container.innerHTML = chips
    .map((c) => `<button class="rel-chip ${escapeHTML(c.cls || "")}" data-target="${escapeHTML(c.id)}">${escapeHTML(c.label)}</button>`)
    .join("");

  container.querySelectorAll(".rel-chip").forEach((btn) => {
    btn.addEventListener("click", () => flyToMember(btn.dataset.target));
  });
}

function renderMemberLetters(member) {
  const container = document.getElementById("letters-container");
  const letters = member.letters || [];
  const voice = getMemberVoiceConfig(member);

  const uploadBtnHTML = canCurrentUserEdit()
    ? `<button class="btn-primary" id="btn-upload-letter-inline">📤 + Subir Carta a Drive</button>`
    : "";

  if (letters.length === 0) {
    container.innerHTML = `
      <div class="bio-story-card" style="text-align:center;">
        <p style="margin-bottom:12px;">Todavía no hay cartas manuscritas para <strong>${escapeHTML(member.name)}</strong>, pero su voz en español está lista.</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          <button class="btn-secondary" id="btn-listen-bio-voice">🔊 Escuchar biografía en español</button>
          ${uploadBtnHTML}
        </div>
      </div>
    `;
    container.querySelector("#btn-listen-bio-voice")?.addEventListener("click", () => {
      speakTextWithMemberVoice(member, [member.bio], "bio-voice");
    });
    container.querySelector("#btn-upload-letter-inline")?.addEventListener("click", () => {
      openUploadModal(member.id, "letter");
    });
    return;
  }

  container.innerHTML =
    (canCurrentUserEdit()
      ? `<div style="margin-bottom:10px;display:flex;justify-content:flex-end;">${uploadBtnHTML}</div>`
      : "") +
    letters
      .map((letter) => {
        const bars = Array.from({ length: 24 })
          .map((_, idx) => `<div class="wave-bar" data-bar="${idx}"></div>`)
          .join("");

        const paragraphsHTML = (letter.paragraphs || [])
          .map((p, idx) => `<p data-pidx="${idx}">${escapeHTML(p)}</p>`)
          .join("");

        const scanImgHTML = letter.scanImageUrl
          ? `<div style="margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid #cbbba4;">
               <img src="${escapeHTML(letter.scanImageUrl)}" alt="${escapeHTML(letter.title)}" style="width:100%;max-height:200px;object-fit:cover;display:block;" />
             </div>`
          : "";

        return `
          <div class="letter-block" data-letter-id="${escapeHTML(letter.id)}">
            <div class="voice-player-box">
              <div class="voice-player-top">
                <button class="btn-play-voice" data-play-letter="${escapeHTML(letter.id)}" title="Leer carta en voz alta">
                  ▶
                </button>
                <div class="voice-meta">
                  <div class="voice-title">🔊 ${escapeHTML(voice.label)}</div>
                  <div class="voice-subtitle">${escapeHTML(voice.sampleSource)} · Español (${escapeHTML(letter.driveSizeKB || 18)} KB)</div>
                </div>
              </div>
              <div class="waveform-bars" id="waveform-${escapeHTML(letter.id)}">
                ${bars}
              </div>
            </div>

            <div class="paper-sheet ${escapeHTML(letter.paperType || "aged-cream")}">
              <div class="paper-header">
                <div>
                  <strong>${escapeHTML(letter.title)}</strong>
                  <div class="paper-date">${escapeHTML(letter.location || "")} · ${escapeHTML(letter.date)}</div>
                </div>
                <div class="paper-stamp">Drive</div>
              </div>

              ${scanImgHTML}

              <div class="paper-paragraphs ${state.cursiveMode ? "cursive-mode" : "print-mode"}"
                   id="paragraphs-${escapeHTML(letter.id)}"
                   style="color: ${escapeHTML(letter.inkColor || "#251e19")}">
                ${paragraphsHTML}
              </div>

              <div class="paper-toolbar">
                <span>☁️ ${escapeHTML(letter.drivePath || "Google Drive del Propietario")}</span>
                <button class="btn-ghost btn-toggle-font" style="padding:3px 8px;font-size:11px;">
                  ${state.cursiveMode ? "🔤 Imprenta" : "✒️ Manuscrita"}
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

  container.querySelector("#btn-upload-letter-inline")?.addEventListener("click", () => {
    openUploadModal(member.id, "letter");
  });

  container.querySelectorAll("[data-play-letter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const letterId = btn.dataset.playLetter;
      const letter = letters.find((l) => l.id === letterId);
      if (!letter) return;

      if (state.speakingLetterId === letterId) {
        stopVoicePlayback();
      } else {
        speakLetter(member, letter, btn);
      }
    });
  });

  container.querySelectorAll(".btn-toggle-font").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.cursiveMode = !state.cursiveMode;
      renderMemberLetters(member);
    });
  });
}

/* ==========================================================================
   MOTOR DE VOZ EN ESPAÑOL (ARCHIVOS WAV + ESPEAK-NG EN SERVIDOR + FALLBACK)
   ========================================================================== */
function getSpanishBrowserVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  return (
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("es-419")) ||
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("es-ar")) ||
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("es-mx")) ||
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("es")) ||
    voices.find((v) => /spanish|español/i.test(v.name || "")) ||
    null
  );
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => getSpanishBrowserVoice();
}

function playSpanishAudioWithFallback(audioUrls, text, onEnded) {
  let idx = 0;

  function tryNextUrl() {
    if (idx >= audioUrls.length) {
      if ("speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(text);
          const esVoice = getSpanishBrowserVoice();
          if (esVoice) utter.voice = esVoice;
          utter.lang = esVoice?.lang || "es-419";
          utter.pitch = 1.0;
          utter.rate = 0.92;
          utter.onend = () => onEnded();
          utter.onerror = () => onEnded();
          window.speechSynthesis.speak(utter);
          return;
        } catch (_) {}
      }
      state.speechTimer = setTimeout(onEnded, Math.max(2000, text.length * 60));
      return;
    }

    const url = audioUrls[idx++];
    const audio = new Audio(url);
    state.currentAudio = audio;

    audio.onended = () => {
      if (state.currentAudio === audio) state.currentAudio = null;
      onEnded();
    };

    audio.onerror = () => {
      if (state.currentAudio === audio) state.currentAudio = null;
      tryNextUrl();
    };

    audio.play().catch(() => {
      if (state.currentAudio === audio) state.currentAudio = null;
      tryNextUrl();
    });
  }

  tryNextUrl();
}

function speakLetter(member, letter, playBtn) {
  stopVoicePlayback();

  state.speakingLetterId = letter.id;
  playBtn.textContent = "⏸";

  const waveform = document.getElementById(`waveform-${letter.id}`);
  if (waveform) waveform.classList.add("playing");

  const paragraphsContainer = document.getElementById(`paragraphs-${letter.id}`);
  const pElements = paragraphsContainer ? Array.from(paragraphsContainer.querySelectorAll("p")) : [];
  const paragraphs = letter.paragraphs || [];
  const { espeakVoice, espeakSpeed, espeakPitch } = getMemberVoiceConfig(member);

  state.waveInterval = setInterval(() => {
    if (state.speakingLetterId !== letter.id) {
      clearInterval(state.waveInterval);
      state.waveInterval = null;
      return;
    }
    if (waveform) {
      waveform.querySelectorAll(".wave-bar").forEach((bar) => {
        const h = 4 + Math.floor(Math.random() * 16);
        bar.style.height = `${h}px`;
      });
    }
  }, 120);

  let currentIdx = 0;

  function readNextParagraph() {
    if (state.speakingLetterId !== letter.id || currentIdx >= paragraphs.length) {
      stopVoicePlayback();
      return;
    }

    pElements.forEach((el, idx) => {
      el.classList.toggle("speaking-active", idx === currentIdx);
    });
    pElements[currentIdx]?.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const text = paragraphs[currentIdx];
    const staticWavUrl = `./audio/${letter.id}-p${currentIdx}.wav`;
    const dynamicTtsUrl = `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(espeakVoice)}&speed=${espeakSpeed}&pitch=${espeakPitch}`;

    playSpanishAudioWithFallback([staticWavUrl, dynamicTtsUrl], text, () => {
      if (state.speakingLetterId !== letter.id) return;
      state.speechTimer = setTimeout(() => {
        currentIdx++;
        readNextParagraph();
      }, 280);
    });
  }

  readNextParagraph();
}

function speakTextWithMemberVoice(member, paragraphs, tempId) {
  stopVoicePlayback();
  state.speakingLetterId = tempId;
  const { espeakVoice, espeakSpeed, espeakPitch } = getMemberVoiceConfig(member);
  const text = paragraphs.join(" ");

  const staticBioWav = `./audio/bio-${member.id}.wav`;
  const dynamicTtsUrl = `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(espeakVoice)}&speed=${espeakSpeed}&pitch=${espeakPitch}`;

  showToast(`🔊 Reproduciendo voz en español de ${member.name}...`);
  playSpanishAudioWithFallback([staticBioWav, dynamicTtsUrl], text, () => {
    stopVoicePlayback();
  });
}

function stopVoicePlayback() {
  state.speakingLetterId = null;
  if (state.waveInterval) {
    clearInterval(state.waveInterval);
    state.waveInterval = null;
  }
  if (state.speechTimer) {
    clearTimeout(state.speechTimer);
    state.speechTimer = null;
  }
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;
    } catch (_) {}
    state.currentAudio = null;
  }
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }
  document.querySelectorAll(".btn-play-voice").forEach((b) => (b.textContent = "▶"));
  document.querySelectorAll(".waveform-bars").forEach((w) => {
    w.classList.remove("playing");
    w.querySelectorAll(".wave-bar").forEach((bar) => (bar.style.height = "5px"));
  });
  document.querySelectorAll(".speaking-active").forEach((p) => p.classList.remove("speaking-active"));
}

/* ==========================================================================
   FOTOS Y VIDEOS DEL FAMILIAR (GOOGLE DRIVE + SWITCH YOUTUBE OCULTO)
   ========================================================================== */
function renderMemberPhotos(member) {
  const container = document.getElementById("photos-container");
  const photos = member.photos || [];
  const addPhotoBtn = canCurrentUserEdit()
    ? `<div style="margin-bottom:10px;display:flex;justify-content:flex-end;">
         <button class="btn-primary" id="btn-upload-photo-inline">📷 + Subir Foto a Drive</button>
       </div>`
    : "";

  if (photos.length === 0) {
    container.innerHTML = `
      ${addPhotoBtn}
      <p style="color:var(--ink-secondary);font-size:13px;">Aún no hay fotografías en la carpeta de Drive de ${escapeHTML(member.name)}.</p>
    `;
  } else {
    container.innerHTML =
      addPhotoBtn +
      photos
        .map((ph) => {
          const visualContent = ph.imageUrl
            ? `<img src="${escapeHTML(ph.imageUrl)}" alt="${escapeHTML(ph.title)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`
            : renderVintagePhotoSVG(ph, member);

          return `
            <div class="photo-card">
              <div class="photo-frame">${visualContent}</div>
              <div class="photo-meta">
                <span>${escapeHTML(ph.title)}</span>
                <span class="years-badge">${escapeHTML(ph.year)}</span>
              </div>
              <p class="photo-caption">${escapeHTML(ph.caption)}</p>
              <div style="margin-top:6px;font-size:11px;color:var(--accent-green);">
                ☁️ ${escapeHTML(ph.drivePath || `Drive / Fotos / ${member.name}`)} (${escapeHTML(ph.sizeKB || 15)} KB)
              </div>
            </div>
          `;
        })
        .join("");
  }

  container.querySelector("#btn-upload-photo-inline")?.addEventListener("click", () => {
    openUploadModal(member.id, "photo");
  });
}

function renderMemberVideos(member) {
  const container = document.getElementById("videos-container");
  const videos = member.videos || [];
  const addVideoBtn = canCurrentUserEdit()
    ? `<div style="margin-bottom:10px;display:flex;justify-content:flex-end;">
         <button class="btn-primary" id="btn-upload-video-inline">🎬 + Subir Video (Drive / YT)</button>
       </div>`
    : "";

  if (videos.length === 0) {
    container.innerHTML = `
      ${addVideoBtn}
      <p style="color:var(--ink-secondary);font-size:13px;">No hay videos familiares registrados para ${escapeHTML(member.name)}.</p>
    `;
  } else {
    container.innerHTML =
      addVideoBtn +
      videos
        .map((v) => {
          const isYoutube = v.uploadedToYoutube !== false && Boolean(v.youtubeUnlistedId || v.uploadedToYoutube);
          const sourceBadge = isYoutube
            ? `🎬 YouTube Oculto (ID: ${escapeHTML(v.youtubeUnlistedId || "Activo")})`
            : `☁️ Solo en Google Drive del Propietario`;

          const videoPlayerBody = v.videoUrl
            ? `<video src="${escapeHTML(v.videoUrl)}" controls style="width:100%;max-height:200px;background:#000;"></video>`
            : `
              <div class="video-screen" id="vscreen-${escapeHTML(v.id)}">
                <div style="font-size:30px;margin-bottom:6px;">${isYoutube ? "🎬" : "☁️"}</div>
                <strong style="font-size:14px;">${escapeHTML(v.title)} (${escapeHTML(v.year)})</strong>
                <p style="font-size:12px;color:#cbbba4;margin-top:4px;max-width:340px;">${escapeHTML(v.description)}</p>
                <button class="btn-primary" style="margin-top:10px;" data-play-video="${escapeHTML(v.id)}">
                  ▶ ${isYoutube ? "Reproducir YouTube" : "Reproducir Drive"} (${escapeHTML(v.duration || "Video")})
                </button>
              </div>
            `;

          return `
            <div class="video-card">
              ${videoPlayerBody}
              <div class="video-controls-bar">
                <span>${sourceBadge}</span>
                ${
                  isYoutube
                    ? `<label>
                         Calidad:
                         <select style="background:#171310;color:#fff;border:1px solid #55483d;border-radius:5px;padding:2px 6px;font-size:11px;">
                           <option value="240p">240p (Señal Débil)</option>
                           <option value="480p" selected>480p (Media)</option>
                           <option value="720p">720p HD</option>
                         </select>
                       </label>`
                    : `<span style="font-size:11px;color:#cbbba4;">📁 Directo de Drive</span>`
                }
              </div>
            </div>
          `;
        })
        .join("");
  }

  container.querySelector("#btn-upload-video-inline")?.addEventListener("click", () => {
    openUploadModal(member.id, "video");
  });

  container.querySelectorAll("[data-play-video]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.textContent = "⏳ Reproduciendo video...";
      showToast("🎬 Reproducción iniciada");
    });
  });
}

/* ==========================================================================
   VISTA LISTA COMPACTA PARA CELULARES (DINÁMICA POR SUBNIVELES)
   ========================================================================== */
function renderCompactListView() {
  const container = document.getElementById("list-container");
  if (!container) return;

  const gens = Array.from(new Set(state.members.map((m) => Number(m.generation ?? 1)))).sort((a, b) => a - b);

  container.innerHTML = gens
    .map((gen) => {
      const items = state.members
        .filter((m) => Number(m.generation ?? 1) === gen && matchesFilter(m))
        .map(
          (m) => `
          <div class="family-node" style="position:static;width:100%;" data-list-member="${escapeHTML(m.id)}">
            <div class="node-top">
              <div class="node-avatar">${renderPortraitSVG(m)}</div>
              <div class="node-info">
                <span class="node-role-pill">${escapeHTML(m.role)}</span>
                <div class="node-name">${escapeHTML(m.name)}</div>
                <div class="node-years">${escapeHTML(m.birthYear)} – ${escapeHTML(m.deathYear)}</div>
              </div>
            </div>
            <div class="node-occupation">${escapeHTML(m.occupation)}</div>
          </div>
        `
        )
        .join("");

      return `
        <div class="list-gen-group">
          <div class="list-gen-title">${getGenerationLabel(gen)}</div>
          <div class="list-grid">${items}</div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-list-member]").forEach((el) => {
    el.addEventListener("click", () => openMemberDrawer(el.dataset.listMember));
  });
}

/* ==========================================================================
   MENÚ HAMBURGUESA LATERAL (☰), BARRA COMPACTA, BUSCADOR Y LOGIN
   ========================================================================== */
function openSidebarMenu() {
  document.getElementById("sidebar-menu")?.classList.remove("hidden");
  document.getElementById("sidebar-backdrop")?.classList.remove("hidden");
}

function closeSidebarMenu() {
  document.getElementById("sidebar-menu")?.classList.add("hidden");
  document.getElementById("sidebar-backdrop")?.classList.add("hidden");
}

function setupAuthEvents() {
  const modal = document.getElementById("auth-modal");
  const select = document.getElementById("auth-email-select");
  const btnLogin = document.getElementById("btn-google-login");
  const errorBox = document.getElementById("auth-error");
  const userChip = document.getElementById("user-chip");
  const btnOpenAuth = document.getElementById("btn-open-auth-modal");
  const sidebarSwitcher = document.getElementById("sidebar-role-switcher");

  btnLogin?.addEventListener("click", () => {
    const email = select.value;
    const meta = getMetadata();
    const allowed = (meta.allowedEmails || []).map((e) => e.toLowerCase());

    if (email === "desconocido@gmail.com" || (allowed.length && !allowed.includes(email.toLowerCase()))) {
      errorBox.classList.remove("hidden");
      return;
    }
    errorBox.classList.add("hidden");
    state.currentUserEmail = email;
    updateRoleUI();
    modal.classList.add("hidden");
    showToast(`Sesión: ${email} (${getUserRoleLabel(email)})`);
  });

  userChip?.addEventListener("click", () => {
    closeSidebarMenu();
    renderAuthSelectOptions();
    modal.classList.remove("hidden");
  });

  btnOpenAuth?.addEventListener("click", () => {
    closeSidebarMenu();
    renderAuthSelectOptions();
    modal.classList.remove("hidden");
  });

  sidebarSwitcher?.addEventListener("change", () => {
    state.currentUserEmail = sidebarSwitcher.value;
    updateRoleUI();
    if (state.selectedMemberId) openMemberDrawer(state.selectedMemberId);
    showToast(`Rol cambiado a ${getUserRoleLabel(state.currentUserEmail)}`);
  });
}

function setupSidebarAndToolbarEvents() {
  // Abrir y cerrar Menú Hamburguesa (☰)
  document.getElementById("btn-open-sidebar")?.addEventListener("click", openSidebarMenu);
  document.getElementById("btn-close-sidebar")?.addEventListener("click", closeSidebarMenu);
  document.getElementById("sidebar-backdrop")?.addEventListener("click", closeSidebarMenu);

  // Filtros de Ramas dentro del Menú Hamburguesa
  document.querySelectorAll(".sidebar-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeFilter = btn.dataset.filter;
      renderNodes();
      renderCompactListView();
      closeSidebarMenu();
      showToast(`🌿 Filtro aplicado: ${btn.textContent.trim()}`);
    });
  });

  // Conmutador Vista Lienzo / Vista Lista en la barra superior
  const btnCanvas = document.getElementById("btn-view-canvas");
  const btnList = document.getElementById("btn-view-list");
  const canvasView = document.getElementById("canvas-viewport");
  const listView = document.getElementById("list-viewport");

  btnCanvas?.addEventListener("click", () => {
    btnCanvas.classList.add("active");
    btnList.classList.remove("active");
    canvasView.classList.remove("hidden");
    listView.classList.add("hidden");
  });

  btnList?.addEventListener("click", () => {
    btnList.classList.add("active");
    btnCanvas.classList.remove("active");
    listView.classList.remove("hidden");
    canvasView.classList.add("hidden");
  });

  // Botones de acción rápida en la barra superior
  document.getElementById("btn-quick-add-member")?.addEventListener("click", () => {
    openMemberModal({ mode: "create" });
  });
  document.getElementById("btn-quick-upload")?.addEventListener("click", () => {
    openUploadModal(state.selectedMemberId || "abuelo-pat", "photo");
  });

  // Buscador siempre accesible en la barra superior
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("btn-clear-search");
  const resultsBox = document.getElementById("search-results");

  searchInput?.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    clearBtn?.classList.toggle("hidden", !q);
    if (!q) {
      resultsBox.classList.add("hidden");
      return;
    }
    const matches = state.members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        (m.occupation || "").toLowerCase().includes(q) ||
        (m.birthPlace || "").toLowerCase().includes(q)
    );

    if (matches.length === 0) {
      resultsBox.innerHTML = `<div class="search-item">Sin resultados</div>`;
    } else {
      resultsBox.innerHTML = matches
        .map(
          (m) => `
          <div class="search-item" data-search-id="${escapeHTML(m.id)}">
            <strong>${escapeHTML(m.name)}</strong>
            <span style="color:var(--ink-muted);font-size:11.5px;">${escapeHTML(m.role)}</span>
          </div>
        `
        )
        .join("");
    }
    resultsBox.classList.remove("hidden");

    resultsBox.querySelectorAll("[data-search-id]").forEach((item) => {
      item.addEventListener("click", () => {
        const id = item.dataset.searchId;
        resultsBox.classList.add("hidden");
        searchInput.value = "";
        clearBtn?.classList.add("hidden");
        if ( !canvasView.classList.contains("hidden") ) {
          flyToMember(id);
        } else {
          openMemberDrawer(id);
        }
      });
    });
  });

  clearBtn?.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.classList.add("hidden");
    resultsBox.classList.add("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) {
      resultsBox?.classList.add("hidden");
    }
  });

  // Botón ↺ Ordenar Tablero: Alinea todos los parientes actuales SIN borrar ninguno
  document.getElementById("btn-reset-layout")?.addEventListener("click", async () => {
    closeSidebarMenu();
    if (!canCurrentUserEdit()) return;
    try {
      const res = await fetch("/api/family/tidy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userEmail: state.currentUserEmail })
      });
      const json = await res.json();
      if (json.ok && json.data) {
        state.familyData = json.data;
        state.members = json.data.members || state.members;
        state.historyLog = json.data.historyLog || state.historyLog;
      } else {
        tidyLayoutLocally();
      }
    } catch (_) {
      tidyLayoutLocally();
      addLocalHistoryEntry(
        "layout_tidied",
        "Ordenó y alineó automáticamente las tarjetas del lienzo",
        `Se organizaron los ${state.members.length} familiares conservando todos los parientes nuevos.`
      );
    }
    renderAll();
    fitTreeToScreen(true);
    showToast(`✨ ${state.members.length} familiares alineados sin borrar datos`);
  });
}

function setupDrawerEvents() {
  document.getElementById("btn-close-drawer")?.addEventListener("click", closeMemberDrawer);
  document.getElementById("member-drawer-backdrop")?.addEventListener("click", closeMemberDrawer);

  // Botón expandir / contraer altura del panel en móviles (⤢)
  const toggleExpandDrawer = () => {
    const drawer = document.getElementById("member-drawer");
    drawer?.classList.toggle("expanded-full");
  };
  document.getElementById("btn-expand-drawer")?.addEventListener("click", toggleExpandDrawer);
  document.getElementById("drawer-drag-handle")?.addEventListener("click", toggleExpandDrawer);

  document.querySelectorAll(".drawer-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      stopVoicePlayback();
      const tabName = tabBtn.dataset.tab;
      document.querySelectorAll(".drawer-tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

      tabBtn.classList.add("active");
      document.getElementById(`tab-panel-${tabName}`)?.classList.add("active");
    });
  });

  // Botón Eliminar Familiar (Directo para Propietario, o Solicitud de Validación para Co-editor)
  document.getElementById("btn-delete-current-member")?.addEventListener("click", async () => {
    const member = state.members.find((m) => m.id === state.selectedMemberId);
    if (!member) return;
    await requestOrExecuteMemberDeletion(member);
  });
}

/* ==========================================================================
   MODAL 1: GESTIÓN DE PERMISOS RESPONSIVA CON BOTONES DE ÍCONO (✏️, ⬆️, ⬇️, 🗑️)
   ========================================================================== */
function setupPermissionsModal() {
  const modal = document.getElementById("modal-permissions");
  const btnOpen = document.getElementById("btn-open-permissions");
  const btnClose = document.getElementById("btn-close-permissions-modal");
  const formCoEditor = document.getElementById("form-add-coeditor");
  const formViewer = document.getElementById("form-add-viewer");
  const quickSwitcher = document.getElementById("quick-role-switcher");

  btnOpen?.addEventListener("click", () => {
    closeSidebarMenu();
    renderPermissionsModalContent();
    modal.classList.remove("hidden");
  });

  btnClose?.addEventListener("click", () => modal.classList.add("hidden"));

  quickSwitcher?.addEventListener("change", () => {
    state.currentUserEmail = quickSwitcher.value;
    updateRoleUI();
    renderPermissionsModalContent();
    if (state.selectedMemberId) openMemberDrawer(state.selectedMemberId);
    showToast(`Vista: ${state.currentUserEmail} (${getUserRoleLabel(state.currentUserEmail)})`);
  });

  formCoEditor?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isCurrentUserOwner()) {
      showToast("⛔ Solo el Propietario Único puede añadir co-editores.");
      return;
    }
    const input = document.getElementById("input-new-coeditor");
    const newEmail = input.value.trim().toLowerCase();
    if (!newEmail) return;

    const meta = getMetadata();
    if (newEmail === meta.ownerEmail.toLowerCase()) {
      showToast("Ese correo ya es el propietario.");
      return;
    }
    if (!meta.coEditors.includes(newEmail)) meta.coEditors.push(newEmail);
    if (!meta.allowedEmails.includes(newEmail)) meta.allowedEmails.push(newEmail);

    await syncPermissionsWithServer(`Añadió a ${newEmail} como Co-editor`);
    input.value = "";
    renderPermissionsModalContent();
    updateRoleUI();
    showToast(`✍️ ${newEmail} añadido como Co-editor`);
  });

  formViewer?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canCurrentUserEdit()) {
      showToast("⛔ Solo el Propietario y Co-editores pueden añadir lectores.");
      return;
    }
    const input = document.getElementById("input-new-viewer");
    const newEmail = input.value.trim().toLowerCase();
    if (!newEmail) return;

    const meta = getMetadata();
    if (!meta.allowedEmails.includes(newEmail)) meta.allowedEmails.push(newEmail);

    await syncPermissionsWithServer(`Añadió a ${newEmail} como Familiar Lector`);
    input.value = "";
    renderPermissionsModalContent();
    updateRoleUI();
    showToast(`👁️ ${newEmail} añadido como Lector`);
  });
}

function renderPermissionsModalContent() {
  const meta = getMetadata();
  const isOwner = isCurrentUserOwner();
  const canEditViewers = canCurrentUserEdit();
  document.getElementById("perm-owner-email").textContent = meta.ownerEmail;

  const switcher = document.getElementById("quick-role-switcher");
  const allUsers = Array.from(new Set([meta.ownerEmail, ...(meta.coEditors || []), ...(meta.allowedEmails || [])]));
  switcher.innerHTML = allUsers
    .map((u) => `<option value="${u}" ${u === state.currentUserEmail ? "selected" : ""}>${getUserRoleLabel(u)} · ${u}</option>`)
    .join("");

  const formCoEditor = document.getElementById("form-add-coeditor");
  const formViewer = document.getElementById("form-add-viewer");
  if (formCoEditor) formCoEditor.classList.toggle("hidden", !isOwner);
  if (formViewer) formViewer.classList.toggle("hidden", !canEditViewers);

  // Lista de Co-editores con botones de íconos compactos para móviles
  const coList = document.getElementById("coeditors-list");
  if ((meta.coEditors || []).length === 0) {
    coList.innerHTML = `<div style="font-size:12px;color:var(--ink-muted);">No hay co-editores designados.</div>`;
  } else {
    coList.innerHTML = meta.coEditors
      .map(
        (ce) => `
        <div class="perm-item">
          <div class="perm-email-cell" title="${ce}">✍️ <strong>${ce}</strong></div>
          <div class="perm-actions-cell">
            ${
              isOwner
                ? `<button class="perm-icon-btn" title="Editar correo" data-edit-coeditor="${ce}">✏️</button>
                   <button class="perm-icon-btn" title="Pasar a Lector" data-demote-coeditor="${ce}">⬇️</button>
                   <button class="perm-icon-btn danger" title="Eliminar co-editor" data-remove-coeditor="${ce}">🗑️</button>`
                : `<span style="font-size:11px;color:var(--ink-muted);">Co-editor</span>`
            }
          </div>
        </div>
      `
      )
      .join("");
  }

  // Lista de Lectores con botones de íconos compactos para móviles
  const viewers = (meta.allowedEmails || []).filter(
    (e) =>
      e.toLowerCase() !== meta.ownerEmail.toLowerCase() &&
      !meta.coEditors.some((ce) => ce.toLowerCase() === e.toLowerCase())
  );
  const vwList = document.getElementById("viewers-list");
  if (viewers.length === 0) {
    vwList.innerHTML = `<div style="font-size:12px;color:var(--ink-muted);">No hay lectores registrados.</div>`;
  } else {
    vwList.innerHTML = viewers
      .map(
        (vw) => `
        <div class="perm-item">
          <div class="perm-email-cell" title="${vw}">👁️ ${vw}</div>
          <div class="perm-actions-cell">
            ${
              isOwner
                ? `<button class="perm-icon-btn" title="Promover a Co-editor" data-promote-viewer="${vw}">⬆️</button>`
                : ""
            }
            ${
              canEditViewers
                ? `<button class="perm-icon-btn" title="Editar correo" data-edit-viewer="${vw}">✏️</button>
                   <button class="perm-icon-btn danger" title="Eliminar lector" data-remove-viewer="${vw}">🗑️</button>`
                : `<span style="font-size:11px;color:var(--ink-muted);">Lector</span>`
            }
          </div>
        </div>
      `
      )
      .join("");
  }

  // Eventos para Co-editores
  coList.querySelectorAll("[data-edit-coeditor]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const oldEmail = btn.dataset.editCoeditor;
      const newEmailRaw = window.prompt(`Editar dirección de correo del Co-editor (${oldEmail}):`, oldEmail);
      if (!newEmailRaw) return;
      const newEmail = newEmailRaw.trim().toLowerCase();
      if (!newEmail || newEmail === oldEmail.toLowerCase()) return;

      meta.coEditors = meta.coEditors.map((c) => (c.toLowerCase() === oldEmail.toLowerCase() ? newEmail : c));
      meta.allowedEmails = meta.allowedEmails.map((a) => (a.toLowerCase() === oldEmail.toLowerCase() ? newEmail : a));
      if (state.currentUserEmail.toLowerCase() === oldEmail.toLowerCase()) {
        state.currentUserEmail = newEmail;
      }
      await syncPermissionsWithServer(`Actualizó el correo del co-editor ${oldEmail} → ${newEmail}`);
      renderPermissionsModalContent();
      updateRoleUI();
      showToast(`✏️ Correo actualizado a ${newEmail}`);
    });
  });

  coList.querySelectorAll("[data-demote-coeditor]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.demoteCoeditor;
      meta.coEditors = meta.coEditors.filter((c) => c.toLowerCase() !== target.toLowerCase());
      await syncPermissionsWithServer(`Cambió a ${target} de Co-editor a Lector`);
      renderPermissionsModalContent();
      updateRoleUI();
      showToast(`👁️ ${target} pasó a Solo Lectura`);
    });
  });

  coList.querySelectorAll("[data-remove-coeditor]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.removeCoeditor;
      meta.coEditors = meta.coEditors.filter((c) => c.toLowerCase() !== target.toLowerCase());
      meta.allowedEmails = meta.allowedEmails.filter((a) => a.toLowerCase() !== target.toLowerCase());
      await syncPermissionsWithServer(`Eliminó al co-editor ${target} del lienzo`);
      renderPermissionsModalContent();
      updateRoleUI();
      showToast(`🗑️ ${target} eliminado`);
    });
  });

  // Eventos para Lectores
  vwList.querySelectorAll("[data-promote-viewer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.promoteViewer;
      if (!meta.coEditors.includes(target)) meta.coEditors.push(target);
      await syncPermissionsWithServer(`Promovió a ${target} como Co-editor`);
      renderPermissionsModalContent();
      updateRoleUI();
      showToast(`✍️ ${target} ahora es Co-editor`);
    });
  });

  vwList.querySelectorAll("[data-edit-viewer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const oldEmail = btn.dataset.editViewer;
      const newEmailRaw = window.prompt(`Editar dirección de correo del Lector (${oldEmail}):`, oldEmail);
      if (!newEmailRaw) return;
      const newEmail = newEmailRaw.trim().toLowerCase();
      if (!newEmail || newEmail === oldEmail.toLowerCase()) return;

      meta.allowedEmails = meta.allowedEmails.map((a) => (a.toLowerCase() === oldEmail.toLowerCase() ? newEmail : a));
      await syncPermissionsWithServer(`Actualizó el correo del lector ${oldEmail} → ${newEmail}`);
      renderPermissionsModalContent();
      updateRoleUI();
      showToast(`✏️ Correo actualizado a ${newEmail}`);
    });
  });

  vwList.querySelectorAll("[data-remove-viewer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.removeViewer;
      meta.allowedEmails = meta.allowedEmails.filter((a) => a.toLowerCase() !== target.toLowerCase());
      await syncPermissionsWithServer(`Eliminó al lector ${target} de la lista de acceso`);
      renderPermissionsModalContent();
      updateRoleUI();
      showToast(`🗑️ ${target} eliminado`);
    });
  });
}

async function syncPermissionsWithServer(actionDesc = "Actualizó permisos del lienzo") {
  const meta = getMetadata();
  const payload = {
    requesterEmail: state.currentUserEmail,
    allowedEmails: meta.allowedEmails,
    actionDesc
  };
  if (isCurrentUserOwner()) {
    payload.coEditors = meta.coEditors;
  }

  try {
    const res = await fetch("/api/family/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.ok && json.historyLog) {
      state.historyLog = json.historyLog;
    }
  } catch (_) {
    addLocalHistoryEntry("permissions_changed", actionDesc);
  }
}

/* ==========================================================================
   SISTEMA DE VALIDACIÓN DE DECISIONES (CO-EDITOR SOLICITA -> PROPIETARIO DECIDE)
   ========================================================================== */
function setupApprovalsModal() {
  const modal = document.getElementById("modal-approvals");
  const btnOpen = document.getElementById("btn-open-approvals");
  const btnClose = document.getElementById("btn-close-approvals-modal");

  btnOpen?.addEventListener("click", () => {
    closeSidebarMenu();
    renderApprovalsModalContent();
    modal.classList.remove("hidden");
  });

  btnClose?.addEventListener("click", () => modal.classList.add("hidden"));
}

async function requestOrExecuteMemberDeletion(member) {
  if (!canCurrentUserEdit()) {
    showToast("👁️ Estás en Modo Solo Lectura.");
    return;
  }

  if (isCurrentUserOwner()) {
    const ok = window.confirm(
      `👑 Como Propietario Único, ¿confirmas eliminar definitivamente a ${member.name} (${member.role}) del árbol?`
    );
    if (!ok) return;
    await sendDeleteMemberRequest(member, "Eliminación directa por el propietario");
  } else {
    const reason = window.prompt(
      `✍️ Como Co-editor, eliminar a un familiar requiere la aprobación final del Propietario (${getMetadata().ownerEmail}).\n\nIndica el motivo para enviar la solicitud:`,
      "Cargado por duplicado / Corregir rama"
    );
    if (reason === null) return;
    await sendDeleteMemberRequest(member, reason.trim() || "Solicitud de co-editor");
  }
}

async function sendDeleteMemberRequest(member, reason) {
  try {
    const res = await fetch("/api/family/delete-member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userEmail: state.currentUserEmail,
        memberId: member.id,
        reason
      })
    });
    const json = await res.json();
    if (json.ok && json.data) {
      state.familyData = json.data;
      state.members = json.data.members || [];
      state.pendingApprovals = json.data.pendingApprovals || [];
      state.historyLog = json.data.historyLog || [];

      if (json.status === "deleted") {
        closeMemberDrawer();
        renderAll();
        showToast(`🗑️ ${member.name} fue eliminado del árbol`);
      } else {
        renderAll();
        openMemberDrawer(member.id);
        showToast(`⚖️ Solicitud enviada al propietario para validar la baja de ${member.name}`);
      }
      return;
    }
  } catch (_) {
    if (isCurrentUserOwner()) {
      state.members = state.members.filter((m) => m.id !== member.id);
      addLocalHistoryEntry("approval_resolved", `Eliminó directamente a ${member.name} (${member.role})`, reason);
      closeMemberDrawer();
      renderAll();
      showToast(`🗑️ ${member.name} fue eliminado del árbol`);
    } else {
      state.pendingApprovals.unshift({
        id: `req-${Date.now()}`,
        type: "delete_member",
        targetMemberId: member.id,
        targetMemberName: member.name,
        targetMemberRole: member.role,
        requestedBy: state.currentUserEmail,
        requestedByRole: "Co-editor",
        reason,
        createdAt: nowFormatted()
      });
      addLocalHistoryEntry(
        "approval_requested",
        `Solicitó autorización al propietario para eliminar a ${member.name}`,
        `Motivo: ${reason}`
      );
      renderAll();
      openMemberDrawer(member.id);
      showToast(`⚖️ Solicitud enviada al propietario para validar la baja de ${member.name}`);
    }
  }
}

function renderApprovalsModalContent() {
  const container = document.getElementById("approvals-list-container");
  const pending = state.pendingApprovals || [];
  const isOwner = isCurrentUserOwner();

  if (pending.length === 0) {
    container.innerHTML = `
      <div class="bio-story-card" style="text-align:center;margin-bottom:0;">
        ✅ <strong>No hay decisiones pendientes de validación.</strong><br/>
        <span style="font-size:12px;color:var(--ink-secondary);">
          Si cambias al rol de un <strong>Co-editor</strong> e intentas eliminar un pariente, verás aparecer aquí la solicitud esperando aprobación del Propietario.
        </span>
      </div>
    `;
    return;
  }

  container.innerHTML = pending
    .map(
      (req) => `
      <div class="perm-item" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
          <span class="role-badge" style="background:#fdeceb;color:#8f2620;">🗑️ Baja de Pariente</span>
          <span style="font-size:11px;color:var(--ink-muted);">${escapeHTML(req.createdAt)}</span>
        </div>
        <div style="font-size:13px;">
          <strong>${escapeHTML(req.requestedBy)}</strong> solicita eliminar a <strong>${escapeHTML(req.targetMemberName)}</strong> (${escapeHTML(req.targetMemberRole)}).
        </div>
        <div style="font-size:12px;color:var(--ink-secondary);background:#fff;padding:6px 10px;border-radius:6px;border:1px solid var(--border-soft);">
          💬 <strong>Motivo:</strong> ${escapeHTML(req.reason || "Sin motivo especificado")}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;flex-wrap:wrap;">
          ${
            isOwner
              ? `<button class="btn-ghost" data-reject-req="${escapeHTML(req.id)}">❌ Rechazar</button>
                 <button class="btn-primary" style="background:#8f2620;border-color:#8f2620;" data-approve-req="${escapeHTML(req.id)}">✅ Aprobar Baja</button>`
              : `<span style="font-size:11.5px;color:var(--accent-warm);font-weight:600;">⏳ Esperando al Propietario</span>`
          }
        </div>
      </div>
    `
    )
    .join("");

  container.querySelectorAll("[data-approve-req]").forEach((btn) => {
    btn.addEventListener("click", () => resolveApprovalRequest(btn.dataset.approveReq, "approve"));
  });
  container.querySelectorAll("[data-reject-req]").forEach((btn) => {
    btn.addEventListener("click", () => resolveApprovalRequest(btn.dataset.rejectReq, "reject"));
  });
}

async function resolveApprovalRequest(requestId, decision) {
  if (!isCurrentUserOwner()) {
    showToast("⛔ Solo el Propietario Único puede aprobar o rechazar esta decisión.");
    return;
  }

  try {
    const res = await fetch("/api/family/resolve-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userEmail: state.currentUserEmail,
        requestId,
        decision
      })
    });
    const json = await res.json();
    if (json.ok && json.data) {
      state.familyData = json.data;
      state.members = json.data.members || [];
      state.pendingApprovals = json.data.pendingApprovals || [];
      state.historyLog = json.data.historyLog || [];
    }
  } catch (_) {
    const reqObj = state.pendingApprovals.find((r) => r.id === requestId);
    state.pendingApprovals = state.pendingApprovals.filter((r) => r.id !== requestId);
    if (reqObj && decision === "approve") {
      state.members = state.members.filter((m) => m.id !== reqObj.targetMemberId);
      addLocalHistoryEntry("approval_resolved", `✅ Aprobó eliminar a ${reqObj.targetMemberName}`);
    } else if (reqObj) {
      addLocalHistoryEntry("approval_resolved", `❌ Rechazó eliminar a ${reqObj.targetMemberName}`);
    }
  }

  closeMemberDrawer();
  renderAll();
  renderApprovalsModalContent();
  showToast(
    decision === "approve"
      ? "✅ Eliminación aprobada y ejecutada"
      : "❌ Solicitud rechazada: el familiar se conserva"
  );
}

/* ==========================================================================
   MODAL 5: HISTORIAL DE MODIFICACIONES
   ========================================================================== */
function setupHistoryModal() {
  const modal = document.getElementById("modal-history");
  const btnOpen = document.getElementById("btn-open-history");
  const btnClose = document.getElementById("btn-close-history-modal");

  btnOpen?.addEventListener("click", () => {
    closeSidebarMenu();
    renderHistoryModalContent();
    modal.classList.remove("hidden");
  });

  btnClose?.addEventListener("click", () => modal.classList.add("hidden"));

  document.querySelectorAll("#history-filter-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#history-filter-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.historyFilter = pill.dataset.hfilter;
      renderHistoryModalContent();
    });
  });
}

function renderHistoryModalContent() {
  const container = document.getElementById("history-list-container");
  const list = (state.historyLog || []).filter((item) => {
    if (state.historyFilter === "all") return true;
    if (state.historyFilter === "coeditors") return item.actorRole === "Co-editor";
    if (state.historyFilter === "members") return item.category === "member_added" || item.category === "member_edited";
    if (state.historyFilter === "media") return item.category === "media_uploaded";
    if (state.historyFilter === "approvals") {
      return (
        item.category === "approval_requested" ||
        item.category === "approval_resolved" ||
        item.category === "permissions_changed"
      );
    }
    return true;
  });

  if (list.length === 0) {
    container.innerHTML = `<div style="font-size:13px;color:var(--ink-muted);padding:12px;text-align:center;">No hay registros para este filtro todavía.</div>`;
    return;
  }

  const iconByCat = {
    member_added: "🌳",
    member_edited: "✏️",
    media_uploaded: "📤",
    approval_requested: "⏳",
    approval_resolved: "⚖️",
    permissions_changed: "🔐",
    layout_tidied: "✨"
  };

  container.innerHTML = list
    .map((item) => {
      const isCoEditor = item.actorRole === "Co-editor";
      const rolePillStyle = isCoEditor
        ? "background:#e3f1ea;color:#27523b;border:1px solid #b6d8c5;"
        : "background:#f2e2d2;color:#8c4f30;border:1px solid #dfcaa9;";

      return `
        <div class="perm-item" style="flex-direction:column;align-items:stretch;gap:5px;padding:10px 12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;${rolePillStyle}">
              ${isCoEditor ? "✍️ Co-editor" : "👑 Propietario"} · ${escapeHTML(item.actorEmail)}
            </span>
            <span style="font-size:10.5px;color:var(--ink-muted);">🕒 ${escapeHTML(item.timestamp)}</span>
          </div>
          <div style="font-size:12.5px;font-weight:600;color:var(--ink-primary);margin-top:2px;">
            ${iconByCat[item.category] || "📌"} ${escapeHTML(item.summary)}
          </div>
          ${
            item.details
              ? `<div style="font-size:11.5px;color:var(--ink-secondary);">${escapeHTML(item.details)}</div>`
              : ""
          }
        </div>
      `;
    })
    .join("");
}

/* ==========================================================================
   MODAL 2: SUBIDA AL DRIVE DEL PROPIETARIO + INTERRUPTOR DE YOUTUBE
   ========================================================================== */
function setupUploadModal() {
  const modal = document.getElementById("modal-upload");
  const form = document.getElementById("form-upload-media");
  const typeSelect = document.getElementById("upload-type-select");
  const fileInput = document.getElementById("upload-file-input");
  const ytToggle = document.getElementById("upload-youtube-toggle");
  const ytStatusText = document.getElementById("yt-toggle-status-text");
  const submitBtn = document.getElementById("btn-submit-upload");

  document.getElementById("btn-open-upload")?.addEventListener("click", () => {
    closeSidebarMenu();
    openUploadModal(state.selectedMemberId || "abuelo-pat", "photo");
  });

  document.getElementById("btn-upload-for-member")?.addEventListener("click", () => {
    openUploadModal(state.selectedMemberId || "abuelo-pat", "photo");
  });

  document.getElementById("btn-close-upload-modal")?.addEventListener("click", () => modal.classList.add("hidden"));
  document.getElementById("btn-cancel-upload")?.addEventListener("click", () => modal.classList.add("hidden"));

  typeSelect?.addEventListener("change", () => updateUploadModalFields());

  ytToggle?.addEventListener("change", () => {
    if (ytToggle.checked) {
      ytStatusText.innerHTML = `<strong>Activado:</strong> Se sube al canal del propietario como <em>Oculto</em> con calidad adaptativa (240p/480p/720p).`;
      submitBtn.textContent = "🎬 Subir a Drive + YouTube";
    } else {
      ytStatusText.innerHTML = `<strong>Desactivado:</strong> Se guardará <em>únicamente en el Google Drive del propietario</em>.`;
      submitBtn.textContent = "☁️ Subir solo a Drive";
    }
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      state.pendingUploadDataUrl = null;
      return;
    }
    const maxFileBytes = 18 * 1024 * 1024; // 18 MB crudos (~24 MB en Base64)
    if (file.size > maxFileBytes) {
      fileInput.value = "";
      state.pendingUploadDataUrl = null;
      showToast("⚠️ El archivo supera el límite de 18 MB permitido.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      state.pendingUploadDataUrl = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canCurrentUserEdit()) {
      showToast("⛔ No tienes permisos de edición para subir archivos.");
      return;
    }

    const memberId = document.getElementById("upload-member-select").value;
    const mediaType = typeSelect.value;
    const title = document.getElementById("upload-title-input").value.trim();
    const date = document.getElementById("upload-date-input").value.trim();
    const description = document.getElementById("upload-desc-input").value.trim();
    const paperType = document.getElementById("upload-paper-select").value;
    const youtubeUpload = ytToggle.checked;

    const payload = {
      userEmail: state.currentUserEmail,
      memberId,
      mediaType,
      title,
      date,
      description,
      paperType,
      youtubeUpload,
      dataUrl: state.pendingUploadDataUrl
    };

    try {
      const res = await fetch("/api/family/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.ok && json.member) {
        const idx = state.members.findIndex((m) => m.id === memberId);
        if (idx !== -1) state.members[idx] = json.member;
        if (json.historyLog) state.historyLog = json.historyLog;
      }
    } catch (_) {
      const member = state.members.find((m) => m.id === memberId);
      if (member) {
        if (mediaType === "photo") {
          member.photos = member.photos || [];
          member.photos.push({
            id: `foto-${Date.now()}`,
            title,
            year: date,
            caption: description,
            imageUrl: state.pendingUploadDataUrl,
            sizeKB: 16
          });
        } else if (mediaType === "letter") {
          member.letters = member.letters || [];
          member.letters.push({
            id: `carta-${Date.now()}`,
            title,
            date,
            location: "Google Drive del Propietario",
            paperType,
            scanImageUrl: state.pendingUploadDataUrl,
            paragraphs: description.split(/\n+/).filter(Boolean)
          });
        } else if (mediaType === "video") {
          member.videos = member.videos || [];
          member.videos.push({
            id: `vid-${Date.now()}`,
            title,
            year: date,
            duration: "Archivo subido",
            videoUrl: state.pendingUploadDataUrl,
            uploadedToYoutube: youtubeUpload,
            youtubeUnlistedId: youtubeUpload ? `yt-${Date.now()}` : null,
            description
          });
        }
        addLocalHistoryEntry(
          "media_uploaded",
          `Subió ${mediaType} '${title}' para ${member.name}`,
          `Fecha: ${date}`
        );
      }
    }

    state.pendingUploadDataUrl = null;
    modal.classList.add("hidden");
    form.reset();
    renderAll();
    openMemberDrawer(memberId);

    const targetTab = mediaType === "photo" ? "photos" : mediaType === "letter" ? "letters" : "videos";
    document.querySelector(`.drawer-tab[data-tab="${targetTab}"]`)?.click();

    if (mediaType === "video") {
      showToast(
        youtubeUpload
          ? "🎬 Video subido a Drive y precargado en YouTube (Oculto)"
          : "☁️ Video guardado en el Google Drive del propietario"
      );
    } else {
      showToast("☁️ Material subido al Google Drive del propietario");
    }
  });
}

function openUploadModal(defaultMemberId, defaultType = "photo") {
  if (!canCurrentUserEdit()) {
    showToast("👁️ Estás en Modo Solo Lectura.");
    return;
  }
  const meta = getMetadata();
  document.getElementById("upload-owner-label").textContent = meta.ownerEmail;

  const select = document.getElementById("upload-member-select");
  select.innerHTML = state.members
    .map((m) => `<option value="${escapeHTML(m.id)}" ${m.id === defaultMemberId ? "selected" : ""}>${escapeHTML(m.name)} (${escapeHTML(m.role)})</option>`)
    .join("");

  document.getElementById("upload-type-select").value = defaultType;
  state.pendingUploadDataUrl = null;
  document.getElementById("upload-file-input").value = "";
  updateUploadModalFields();
  document.getElementById("modal-upload").classList.remove("hidden");
}

function updateUploadModalFields() {
  const mediaType = document.getElementById("upload-type-select").value;
  const letterOpts = document.getElementById("upload-letter-options");
  const videoOpts = document.getElementById("upload-video-options");
  const descLabel = document.getElementById("upload-desc-label");
  const submitBtn = document.getElementById("btn-submit-upload");
  const ytToggle = document.getElementById("upload-youtube-toggle");

  letterOpts.classList.toggle("hidden", mediaType !== "letter");
  videoOpts.classList.toggle("hidden", mediaType !== "video");

  if (mediaType === "letter") {
    descLabel.firstChild.textContent = "Transcripción de la carta (separa párrafos con Enter para la voz):";
    submitBtn.textContent = "☁️ Subir Carta + Activar Voz";
  } else if (mediaType === "video") {
    descLabel.firstChild.textContent = "Descripción o historia de este video:";
    submitBtn.textContent = ytToggle.checked
      ? "🎬 Subir a Drive + YouTube"
      : "☁️ Subir solo a Drive";
  } else {
    descLabel.firstChild.textContent = "Epígrafe o historia de la fotografía:";
    submitBtn.textContent = "☁️ Subir Fotografía a Drive";
  }
}

/* ==========================================================================
   MODAL 3: AGREGAR O EDITAR FAMILIAR (CON SUBNIVELES HACIA AMBOS LADOS)
   ========================================================================== */
function setupMemberModal() {
  const modal = document.getElementById("modal-member");
  const form = document.getElementById("form-member");

  document.getElementById("btn-new-member")?.addEventListener("click", () => {
    closeSidebarMenu();
    openMemberModal({ mode: "create" });
  });

  document.getElementById("btn-edit-current-member")?.addEventListener("click", () => {
    const member = state.members.find((m) => m.id === state.selectedMemberId);
    if (member) openMemberModal({ mode: "edit", member });
  });

  document.getElementById("btn-add-parent-to-member")?.addEventListener("click", () => {
    const child = state.members.find((m) => m.id === state.selectedMemberId);
    if (!child) return;
    const upperGen = Number(child.generation ?? 1) - 1;
    const suggestedRole =
      upperGen === 0 ? "Bisabuelo/a" : upperGen <= -1 ? "Tatarabuelo/a" : upperGen === 1 ? "Abuelo/a" : "Padre / Madre";

    openMemberModal({
      mode: "create",
      presetChild1: child.id,
      presetGen: upperGen,
      presetBranch: child.branch || "paterna",
      presetRole: suggestedRole
    });
  });

  document.getElementById("btn-add-child-to-member")?.addEventListener("click", () => {
    const parent = state.members.find((m) => m.id === state.selectedMemberId);
    if (!parent) return;
    const lowerGen = Number(parent.generation ?? 2) + 1;
    const suggestedRole =
      lowerGen === 4 ? "Hijo/a o Sobrino/a" : lowerGen === 5 ? "Nieto/a" : lowerGen >= 6 ? "Bisnieto/a" : "Hijo/a";

    const parentParts = getMemberPartnerships(parent);
    const defaultCoParent =
      parent.spouseId ||
      parentParts.find((p) => p.status === "current")?.partnerId ||
      parentParts[parentParts.length - 1]?.partnerId ||
      "";

    openMemberModal({
      mode: "create",
      presetParent1: parent.id,
      presetParent2: defaultCoParent,
      presetGen: lowerGen,
      presetBranch: parent.branch || "paterna",
      presetRole: suggestedRole
    });
  });

  document.getElementById("btn-add-spouse-to-member")?.addEventListener("click", () => {
    const partner = state.members.find((m) => m.id === state.selectedMemberId);
    if (!partner) return;
    const existingCount = getMemberPartnerships(partner).length;
    const nextOrder = existingCount + 1;
    const ordSuffix = nextOrder > 1 ? ` (${nextOrder}ª ♥)` : "";
    openMemberModal({
      mode: "create",
      presetSpouse: partner.id,
      presetSpouseOrder: nextOrder,
      presetSpouseStatus: "current",
      presetGen: Number(partner.generation ?? 2),
      presetBranch: partner.branch || "paterna",
      presetRole: `Pareja de ${partner.name.split(" ")[0]}${ordSuffix}`
    });
  });

  document.getElementById("btn-add-partnership-row")?.addEventListener("click", () => {
    const currentId = document.getElementById("member-id-input")?.value || "";
    const container = document.getElementById("member-partnerships-list");
    const nextOrder = (container?.querySelectorAll(".partnership-row").length || 0) + 1;
    appendPartnershipRow({ partnerId: "", order: nextOrder, status: "current" }, currentId);
  });

  document.getElementById("btn-close-member-modal")?.addEventListener("click", () => modal.classList.add("hidden"));
  document.getElementById("btn-cancel-member")?.addEventListener("click", () => modal.classList.add("hidden"));

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canCurrentUserEdit()) return;

    const existingId = document.getElementById("member-id-input").value.trim();
    const isEdit = Boolean(existingId);
    const existingMember = isEdit ? state.members.find((m) => m.id === existingId) : null;

    const name = document.getElementById("member-name-input").value.trim();
    const nickname = document.getElementById("member-nickname-input").value.trim() || name.split(" ")[0];
    const role = document.getElementById("member-role-input").value.trim();
    const generation = parseInt(document.getElementById("member-gen-select").value, 10);
    const branch = document.getElementById("member-branch-select").value;
    const voiceRaw = document.getElementById("member-voice-select").value;
    const [espeakVoice, espeakSpeedStr, espeakPitchStr] = voiceRaw.split("|");

    const p1 = document.getElementById("member-parent1-select").value;
    const p2 = document.getElementById("member-parent2-select").value;
    const parentIds = [p1, p2].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

    const c1 = document.getElementById("member-child1-select").value;
    const c2 = document.getElementById("member-child2-select").value;
    const childrenIds = [c1, c2].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

    const partnerships = collectPartnershipsFromModal(existingMember);
    const currentPartnership = partnerships.find((p) => p.status === "current");
    const spouseId = currentPartnership ? currentPartnership.partnerId : null;
    const primaryPartnerId = spouseId || partnerships[0]?.partnerId || null;

    const avatarColor = document.getElementById("member-color-select").value;
    const birthYear = document.getElementById("member-birth-input").value.trim();
    const deathYear = document.getElementById("member-death-input").value.trim() || "Presente";
    const birthPlace = document.getElementById("member-place-input").value.trim() || "Argentina";
    const occupation = document.getElementById("member-job-input").value.trim() || "Integrante de la familia";
    const bio = document.getElementById("member-bio-input").value.trim();

    const words = name.split(/\s+/).filter(Boolean);
    const avatarInitials =
      words.length >= 2
        ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();

    let x = existingMember ? existingMember.x : 650;
    let y = existingMember ? existingMember.y : getIdealYForGeneration(generation);

    if (!isEdit) {
      if (primaryPartnerId) {
        const sp = state.members.find((m) => m.id === primaryPartnerId);
        if (sp) {
          const isLeftPartner = partnerships[0]?.status === "previous" || partnerships[0]?.status === "deceased";
          x = isLeftPartner ? Math.max(40, sp.x - 275) : sp.x + 275;
          y = sp.y;
        }
      } else if (childrenIds.length > 0) {
        const ch = state.members.find((m) => m.id === childrenIds[0]);
        if (ch) {
          x = ch.x;
          y = ch.y - 270;
        }
      } else if (parentIds.length > 0) {
        const pObjs = parentIds.map((pid) => state.members.find((m) => m.id === pid)).filter(Boolean);
        if (pObjs.length >= 2) {
          x = Math.round((pObjs[0].x + pObjs[1].x) / 2);
          y = pObjs[0].y + 270;
        } else if (pObjs.length === 1) {
          x = pObjs[0].x + 30;
          y = pObjs[0].y + 270;
        }
      }

      while (state.members.some((m) => Math.abs(m.x - x) < 190 && Math.abs(m.y - y) < 85)) {
        x += 265;
      }
    }

    const memberPayload = {
      id: existingId || `familiar-${Date.now()}`,
      name,
      nickname,
      role,
      generation,
      branch,
      birthYear,
      deathYear,
      birthPlace,
      occupation,
      x,
      y,
      spouseId,
      partnerships,
      parentIds,
      avatarColor,
      avatarInitials,
      voiceProfile: {
        pitch: 1.0,
        rate: 0.94,
        espeakVoice: espeakVoice || "es-419+m1",
        espeakSpeed: parseInt(espeakSpeedStr, 10) || 140,
        espeakPitch: parseInt(espeakPitchStr, 10) || 46,
        label: `Voz en español de ${name}`,
        sampleSource: "Síntesis de voz familiar en español"
      },
      bio,
      milestones: existingMember?.milestones || [{ year: birthYear, event: `Nace en ${birthPlace}.` }],
      letters: existingMember?.letters || [],
      photos: existingMember?.photos || [],
      videos: existingMember?.videos || []
    };

    // Sincronizar nupcias bidireccionalmente en memoria local
    const partnerMap = Object.fromEntries(partnerships.map((p) => [p.partnerId, p]));
    state.members.forEach((m) => {
      if (m.id === memberPayload.id) return;
      let mParts = [...getMemberPartnerships(m)];
      if (partnerMap[m.id]) {
        const pInfo = partnerMap[m.id];
        const rec = {
          partnerId: memberPayload.id,
          order: pInfo.order,
          status: pInfo.status,
          period: pInfo.period || ""
        };
        const rIdx = mParts.findIndex((mp) => mp.partnerId === memberPayload.id);
        if (rIdx !== -1) mParts[rIdx] = rec;
        else mParts.push(rec);
      } else {
        mParts = mParts.filter((mp) => mp.partnerId !== memberPayload.id);
      }
      m.partnerships = mParts;
      const mCurr = mParts.find((mp) => mp.status === "current");
      m.spouseId = mCurr ? mCurr.partnerId : null;
    });
    childrenIds.forEach((cid) => {
      const childObj = state.members.find((m) => m.id === cid);
      if (childObj) {
        childObj.parentIds = childObj.parentIds || [];
        if (!childObj.parentIds.includes(memberPayload.id)) {
          childObj.parentIds.push(memberPayload.id);
        }
      }
    });

    try {
      const res = await fetch("/api/family/member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userEmail: state.currentUserEmail,
          member: memberPayload,
          childrenIds
        })
      });
      const json = await res.json();
      if (json.ok && json.members) {
        state.members = json.members;
        if (json.historyLog) state.historyLog = json.historyLog;
      } else {
        const idx = state.members.findIndex((m) => m.id === memberPayload.id);
        if (idx !== -1) state.members[idx] = memberPayload;
        else state.members.push(memberPayload);
      }
    } catch (_) {
      const idx = state.members.findIndex((m) => m.id === memberPayload.id);
      if (idx !== -1) state.members[idx] = memberPayload;
      else state.members.push(memberPayload);
      addLocalHistoryEntry(
        isEdit ? "member_edited" : "member_added",
        `${isEdit ? "Editó a" : "Agregó a"} ${name} (${role} · Nivel ${generation})`,
        `Rama: ${branch}`
      );
    }

    ensurePositiveCanvasCoordinates();
    await saveNodePositions();

    modal.classList.add("hidden");
    form.reset();
    renderAll();
    flyToMember(memberPayload.id);
    showToast(isEdit ? `✨ Datos de ${name} actualizados` : `🌳 ${name} agregado/a`);
  });
}

function appendPartnershipRow(part = {}, excludeMemberId = "") {
  const container = document.getElementById("member-partnerships-list");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "partnership-row";

  const partnerOptions =
    `<option value="">— Seleccionar pareja —</option>` +
    state.members
      .filter((m) => !excludeMemberId || m.id !== excludeMemberId)
      .map(
        (m) =>
          `<option value="${escapeHTML(m.id)}" ${m.id === part.partnerId ? "selected" : ""}>${escapeHTML(m.name)} (${escapeHTML(m.role)})</option>`
      )
      .join("");

  const orderVal = Number(part.order || 1);
  const statusVal = part.status || "current";

  row.innerHTML = `
    <select class="part-partner-select" title="Familiar pareja">${partnerOptions}</select>
    <select class="part-order-select" title="Orden de nupcias">
      <option value="1" ${orderVal === 1 ? "selected" : ""}>1ª nupcias</option>
      <option value="2" ${orderVal === 2 ? "selected" : ""}>2ª nupcias</option>
      <option value="3" ${orderVal === 3 ? "selected" : ""}>3ª nupcias</option>
      <option value="4" ${orderVal === 4 ? "selected" : ""}>4ª nupcias</option>
    </select>
    <select class="part-status-select" title="Estado del vínculo">
      <option value="current" ${statusVal === "current" ? "selected" : ""}>♥ Pareja Actual</option>
      <option value="previous" ${statusVal === "previous" ? "selected" : ""}>♡ Ex-pareja</option>
      <option value="deceased" ${statusVal === "deceased" ? "selected" : ""}>† Pareja Fallecida</option>
    </select>
    <button type="button" class="partnership-remove-btn" title="Quitar vínculo">✕</button>
  `;

  row.querySelector(".partnership-remove-btn")?.addEventListener("click", () => {
    row.remove();
  });

  container.appendChild(row);
}

function collectPartnershipsFromModal(existingMember = null) {
  const container = document.getElementById("member-partnerships-list");
  if (!container) return [];

  const existingByPartner = Object.fromEntries(
    getMemberPartnerships(existingMember).map((p) => [p.partnerId, p])
  );
  const result = [];
  const seen = new Set();

  container.querySelectorAll(".partnership-row").forEach((row, idx) => {
    const partnerId = row.querySelector(".part-partner-select")?.value || "";
    if (!partnerId || seen.has(partnerId)) return;
    seen.add(partnerId);
    const order = parseInt(row.querySelector(".part-order-select")?.value || String(idx + 1), 10) || idx + 1;
    const status = row.querySelector(".part-status-select")?.value || "current";
    const period = existingByPartner[partnerId]?.period || "";
    result.push({ partnerId, order, status, period });
  });

  return result;
}

function openMemberModal(opts = {}) {
  if (!canCurrentUserEdit()) {
    showToast("👁️ Estás en Modo Solo Lectura.");
    return;
  }
  const modal = document.getElementById("modal-member");
  const titleEl = document.getElementById("modal-member-title");
  const member = opts.member || null;

  const optionsHTML =
    `<option value="">— Ninguno —</option>` +
    state.members
      .filter((m) => !member || m.id !== member.id)
      .map((m) => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.name)} (${escapeHTML(m.role)})</option>`)
      .join("");

  const p1Select = document.getElementById("member-parent1-select");
  const p2Select = document.getElementById("member-parent2-select");
  const c1Select = document.getElementById("member-child1-select");
  const c2Select = document.getElementById("member-child2-select");
  const partnershipsListEl = document.getElementById("member-partnerships-list");

  p1Select.innerHTML = optionsHTML;
  p2Select.innerHTML = optionsHTML;
  c1Select.innerHTML = optionsHTML;
  c2Select.innerHTML = optionsHTML;
  if (partnershipsListEl) partnershipsListEl.innerHTML = "";

  if (opts.mode === "edit" && member) {
    titleEl.textContent = `✏️ Editar a ${member.name}`;
    document.getElementById("member-id-input").value = member.id;
    document.getElementById("member-name-input").value = member.name || "";
    document.getElementById("member-nickname-input").value = member.nickname || "";
    document.getElementById("member-role-input").value = member.role || "";
    document.getElementById("member-gen-select").value = String(member.generation ?? 3);
    document.getElementById("member-branch-select").value = member.branch || "paterna";
    document.getElementById("member-color-select").value = member.avatarColor || "#8C5A3C";
    document.getElementById("member-birth-input").value = member.birthYear || "";
    document.getElementById("member-death-input").value = member.deathYear || "Presente";
    document.getElementById("member-place-input").value = member.birthPlace || "";
    document.getElementById("member-job-input").value = member.occupation || "";
    document.getElementById("member-bio-input").value = member.bio || "";
    p1Select.value = (member.parentIds && member.parentIds[0]) || "";
    p2Select.value = (member.parentIds && member.parentIds[1]) || "";

    const currentChildren = state.members.filter((m) => (m.parentIds || []).includes(member.id));
    c1Select.value = currentChildren[0]?.id || "";
    c2Select.value = currentChildren[1]?.id || "";

    const existingParts = getMemberPartnerships(member);
    if (existingParts.length > 0) {
      existingParts.forEach((p) => appendPartnershipRow(p, member.id));
    } else {
      appendPartnershipRow({ partnerId: "", order: 1, status: "current" }, member.id);
    }
  } else {
    titleEl.textContent = "👤 Agregar Familiar";
    document.getElementById("form-member").reset();
    document.getElementById("member-id-input").value = "";
    document.getElementById("member-death-input").value = "Presente";
    if (opts.presetGen !== undefined) document.getElementById("member-gen-select").value = String(opts.presetGen);
    if (opts.presetBranch) document.getElementById("member-branch-select").value = opts.presetBranch;
    if (opts.presetRole) document.getElementById("member-role-input").value = opts.presetRole;
    if (opts.presetParent1) p1Select.value = opts.presetParent1;
    if (opts.presetParent2) p2Select.value = opts.presetParent2;
    if (opts.presetChild1) c1Select.value = opts.presetChild1;
    if (opts.presetSpouse) {
      appendPartnershipRow(
        {
          partnerId: opts.presetSpouse,
          order: opts.presetSpouseOrder || 1,
          status: opts.presetSpouseStatus || "current"
        },
        ""
      );
    } else {
      appendPartnershipRow({ partnerId: "", order: 1, status: "current" }, "");
    }
  }

  modal.classList.remove("hidden");
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}
