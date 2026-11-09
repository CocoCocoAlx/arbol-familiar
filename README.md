# 🌳 Árbol Genealógico Interactivo ("Lienzo Familiar")

Prototipo local completo para explorar la historia de la **Familia Álvarez – Conti** (12 integrantes en 3 generaciones: 4 abuelos, 2 padres, 2 tíos, 2 hermanos y 2 primos).

## Estructura del Proyecto
- [`server.py`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar/server.py): Servidor local en Python con API REST (`/api/family`, `/api/family/positions`, `/api/family/letter`, `/api/family/reset`) y soporte para red local Wi-Fi.
- [`data/familia.json`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar/data/familia.json): Base de datos con los 12 familiares, sus coordenadas en el lienzo, biografías, fotos, videos y cartas manuscritas con configuración de voz.
- [`public/index.html`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar/public/index.html): Interfaz principal con validación simulada de Google Sign-In + Lista Blanca, buscador con vuelo de cámara, filtros y panel lateral / Bottom Sheet móvil.
- [`public/styles.css`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar/public/styles.css): Estilos responsivos tipo Canva y diseño de hojas de papel antiguo.
- [`public/app.js`](file:///home/vaniaw/.gemini/antigravity/scratch/arbol-familiar/public/app.js): Motor del lienzo infinito, curvas Bézier en tiempo real, lectura sincronizada de cartas con voz personalizada y modo ahorro de datos (PWA).

## Cómo ejecutarlo manualmente en cualquier momento
```bash
cd /home/vaniaw/.gemini/antigravity/scratch/arbol-familiar
python3 server.py
```
Luego abre **`http://localhost:8765`** en tu navegador.
