#!/bin/bash

# 🔧 Build Tailwind CSS para producción
# Genera CSS compilado y minificado desde src/styles.css

echo "📦 Building Tailwind CSS..."

# Instalar dependencias si no existen
if [ ! -d "node_modules" ]; then
  echo "📥 Installing dependencies..."
  npm install -D tailwindcss postcss autoprefixer
fi

# Compilar CSS
npx tailwindcss -i ./src/styles.css -o ./frontend/dist/styles.min.css --minify

echo "✅ CSS compilado: frontend/dist/styles.min.css"
echo "Tamaño:"
ls -lh ./frontend/dist/styles.min.css

echo ""
echo "📝 Próximo paso: Actualizar HTML para usar <link rel=\"stylesheet\" href=\"../dist/styles.min.css\">"
