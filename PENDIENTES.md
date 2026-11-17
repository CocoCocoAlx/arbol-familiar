# Lista de Pendientes y Mejoras (Backlog para Ejecución en Lote)

Este documento reúne las mejoras, correcciones y definiciones de diseño pendientes para implementar en lote en la próxima iteración del proyecto **Árbol Familiar**.

---

## 1. Selector de fechas con calendario interactivo
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Reemplazar el ingreso manual de texto en los campos de fecha (nacimiento, fallecimiento, cartas, fotos, videos) por un selector de calendario visual (`<input type="date">` o selector con opción de "solo año / fecha aproximada" cuando no se conoce el día exacto).
- **Archivos involucrados:**
  - `public/index.html` (`#member-birth-input`, `#member-death-input`, `#upload-date-input`)
  - `public/app.js` (`openMemberModal()`, `setupMemberModal()`, formateo de fecha ISO `YYYY-MM-DD` a formato legible)
  - `public/styles.css` (estilos del calendario acorde a la estética pergamino/editorial)

---

## 2. Eliminar opción de maximizar/restaurar en el panel lateral de biografía
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Quitar el botón y la lógica que alterna entre vista lateral normal y vista maximizada en el cajón de biografía (`#member-drawer`), manteniendo un único tamaño fijo y cómodo.
- **Archivos involucrados:**
  - `public/index.html` (`#btn-Expand-drawer` / botón de maximizar en `.drawer-header-actions`)
  - `public/app.js` (listener del botón de expandir y clase `.drawer-maximized`)
  - `public/styles.css` (reglas `.member-drawer.drawer-maximized`)

---

## 3. Modo adaptativo para teléfonos (independiente de la versión de escritorio)
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Diseñar e implementar una experiencia móvil dedicada e independiente del lienzo libre de escritorio, optimizada para pantallas verticales y gestos táctiles.
- **Propuesta técnica para evaluar al implementar:**
  - Detectar vista móvil (por viewport `< 768px` o selector manual Escritorio / Móvil).
  - Navegación centrada en un **"Familiar Foco"**: muestra al familiar seleccionado en el centro con sus padres arriba, parejas al costado e hijos abajo mediante tarjetas grandes táctiles, más pestaña de **Lista por Generaciones** y **Ficha Biográfica** en pantalla completa (`bottom-sheet`).
- **Archivos involucrados:**
  - `public/index.html`, `public/styles.css`, `public/app.js`

---

## 4. Corregir bug: clic en algunas partes de las tarjetas abre "Crear familiar"
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Actualmente, hacer clic en ciertas zonas o elementos internos de las tarjetas del árbol (`g.tree-node`) dispara la acción de "Crear familiar" (o clic en el lienzo/botón superpuesto) en lugar de abrir la biografía del familiar.
- **Causa probable a revisar en lote:**
  - Propagación de eventos (`e.stopPropagation()`) entre `setupNodeDragging()`, el `click` del nodo y los manejadores del canvas o botones rápidos, o superposición de áreas de clic.
- **Archivos involucrados:**
  - `public/app.js` (`renderNodes()`, `setupNodeDragging()`, listeners de `.tree-node`)
  - `public/styles.css` (`pointer-events` en elementos internos del SVG)

---

## 5. Foto de retrato circular con encuadre facial centrado
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Permitir subir o elegir una foto real de retrato para cada perfil del árbol, recortada en un círculo y con ajuste/encuadre centrado en el rostro (reemplazando la ilustración SVG genérica cuando el familiar tiene foto de perfil).
- **Propuesta técnica para evaluar al implementar:**
  - Selector de imagen en el modal de familiar con vista previa circular interactiva (arrastrar para centrar cara + deslizador de zoom, o detección automática con `FaceDetector` API / recorte manual en `<canvas>` de `256x256` WebP/JPEG).
  - Guardar en `member.avatarUrl` (o `member.portraitPhoto` con `{ url, offsetX, offsetY, zoom }`) y renderizar dentro de un `<clipPath>` circular en la tarjeta del árbol y en la cabecera de la biografía.
- **Archivos involucrados:**
  - `public/index.html`, `public/app.js` (`renderPortraitSVG()`, `openMemberModal()`), `server.py`

---

## 6. Sistema de comentarios y sugerencias de lectores para editores/coeditores
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Crear un canal para que los usuarios con rol **Lector** puedan dejar comentarios, correcciones históricas, sugerencias o peticiones (generales o asociadas a una persona específica del árbol) que sean visibles en una bandeja para **Editores** y **Coeditores**.
- **Propuesta técnica para evaluar al implementar:**
  - Botón **"💬 Dejar sugerencia / comentario"** visible para lectores en la barra superior y dentro de la ficha de cada familiar.
  - Formulario simple: *Nombre del familiar que comenta*, *Persona del árbol relacionada (opcional)*, *Tipo (Corrección de dato, Sugerencia, Pedido de alta, Comentario)* y *Mensaje*.
  - Bandeja de **Comentarios de Lectores** visible solo para Editores y Coeditores (con opción de marcar como "Leído / Resuelto" o "Descartar").
- **Archivos involucrados:**
  - `server.py` (endpoints `GET /api/comments`, `POST /api/comments`, `POST /api/comments/resolve`)
  - `public/index.html`, `public/app.js`, `public/styles.css`

---

## 7. Bloquear acceso de Lectores al panel de "Administración y seguridad" (incluso en modo local)
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Los usuarios en modo **Lector** no deben ver ni poder abrir el botón ni el modal de **Administración y seguridad** (`#btn-approvals-modal` / `#approvals-modal`), ni siquiera cuando la aplicación corre en modo local.
- **Nota de diseño a contemplar:**
  - Separar el **cambio de sesión / ingreso como editor** (un botón discreto de *"🔑 Ingresar como editor"* con clave/PIN o cuenta) del panel de **Administración y seguridad**, de modo que el panel administrativo completo solo exista y sea accesible cuando el rol activo sea `admin` (Editor) o `coeditor`.
- **Archivos involucrados:**
  - `public/index.html` (`#btn-approvals-modal`, `#approvals-modal`)
  - `public/app.js` (`updateRoleUI()`, `openApprovalsModal()`)
  - `server.py` (verificación de rol en endpoints administrativos)

---

## 8. Alternativa de verificación para parientes sin cuenta de Google
- **Estado:** `[x] Arreglado/Incorporado`
- **Descripción:** Muchos familiares (especialmente personas mayores) no tienen cuenta de Google o no recuerdan su contraseña para autenticarse con Google OAuth. Se necesita un método alternativo sencillo y seguro.
- **Alternativas propuestas para elegir o combinar:**
  1. **Código de Invitación Familiar / PIN Personal (Recomendado):** El Editor genera desde el panel un código corto o enlace único para ese familiar (ej. `FAM-MARTA-4821` o un link directo con token). El familiar entra con su nombre y ese código, sin necesitar correo electrónico ni cuenta de Google.
  2. **Enlace Mágico / Código por WhatsApp o Email:** El Editor aprueba al familiar y le comparte por WhatsApp un link de acceso directo firmado criptográficamente (HMAC en `server.py`) que activa su sesión en su teléfono o navegador con un solo toque.
  3. **Usuario + Contraseña / PIN local de 4-6 dígitos:** Registro directo en el servidor familiar con nombre + PIN elegido por el pariente y aprobado por el Editor.
- **Archivos involucrados:**
  - `server.py` (emisión y validación de códigos de invitación / tokens firmados)
  - `public/index.html`, `public/app.js` (pantalla de ingreso unificada: Google o Código Familiar / PIN)
