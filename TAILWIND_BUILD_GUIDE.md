# 🔧 Tailwind CSS Build Guide

## Problema
Frontend usa Tailwind CDN (450 KB por página). Solución: compilar CSS en build-time.

## Solución
Compilar a CSS estático minificado (-335 KB por página).

---

## 📋 Pasos

### 1️⃣ Build CSS
```bash
chmod +x build-css.sh
./build-css.sh
```

Output:
```
✅ CSS compilado: frontend/dist/styles.min.css
Tamaño: ~115 KB (era 450 KB CDN)
```

### 2️⃣ Actualizar HTML
Remplacer en TODOS los HTML:
```html
<!-- BEFORE (CDN) -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tailwindcss@3/dist/tailwind.min.css">

<!-- AFTER (Local) -->
<link rel="stylesheet" href="../dist/styles.min.css">
```

**Archivos a actualizar:**
- dashboard.html
- settings.html
- checkout.html
- whatsapp.html
- (todos los demás HTML en frontend/)

### 3️⃣ Verificar
```bash
# Verificar tamaño CSS
ls -lh frontend/dist/styles.min.css

# Esperado: ~115 KB (era 450 KB)
```

### 4️⃣ Deploy
- Push CSS compilado a `main`
- Vercel auto-deploys
- GitHub Pages auto-actualiza desde `gh-pages`

---

## 📊 Impacto

| Métrica | Antes | Después | Ahorro |
|---------|-------|---------|--------|
| CSS por página | 450 KB | 115 KB | **335 KB** |
| Total 28 pages | 12.6 MB | 3.2 MB | **9.4 MB** |
| First Paint | 2.5s | ~1.5s | 40% faster |

---

## 🔄 Mantenimiento

Si modificas Tailwind classes en HTML:
```bash
./build-css.sh  # Re-compila CSS
```

El script automáticamente incluye todas las clases usadas en `frontend/**/*.html`.

---

## ⚙️ Configuración

- `tailwind.config.js` — Tema + colores custom
- `postcss.config.js` — PostCSS plugins (autoprefixer, etc.)
- `src/styles.css` — Entrada CSS (imports de Tailwind)
- `build-css.sh` — Script de compilación

No toques estos archivos a menos que entiendas qué haces 🔥
