# 🌳 Árbol Genealógico Interactivo ("Lienzo Familiar")

Prototipo local completo para explorar la historia de la **Familia Álvarez – Conti** (12 integrantes en 3 generaciones: 4 abuelos, 2 padres, 2 tíos, 2 hermanos y 2 primos).

## Estructura del Proyecto
- [`server.py`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar-repo/server.py): Servidor local en Python (`ThreadingHTTPServer`) con API REST (`/api/family`, `/api/ocr`, `/api/family/upload`, `/api/family/update-letter-ocr`, `/api/family/member`, `/api/family/tidy`, `/api/family/comments`, `/api/family/auth-code`, `/api/family/access-codes`) y soporte para red local Wi-Fi / Tailscale.
- [`data/familia.json`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar-repo/data/familia.json): Base de datos con los familiares, n-nupcias (`♡ / ♥ / †`), coordenadas, biografías, fotos, videos y cartas manuscritas con configuración de voz.
- [`public/index.html`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar-repo/public/index.html): Interfaz responsiva con Tailwind CSS (Android e iOS), ingreso con Google o Código/PIN familiar, modo móvil *Familiar Foco*, recortador circular de retrato y revisión OCR.
- [`public/styles.css`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar-repo/public/styles.css): Estilos editoriales, áreas seguras (`safe-area-inset`) y hojas de papel antiguo.
- [`public/app.js`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar-repo/public/app.js): Motor del lienzo infinito, curvas Bézier, modo *Familiar Foco*, grabador de audio, motor OCR híbrido y PWA offline.
- [`test_server.py`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar-repo/test_server.py): Pruebas unitarias de integridad, seguridad y endpoints.

## Cómo ejecutarlo manualmente en cualquier momento
```bash
cd /home/vaniaw/.gemini/antigravity/scratch/arbol-familiar
python3 server.py
```
Luego abre **`http://localhost:8765`** en tu navegador.
