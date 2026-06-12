import 'dotenv/config';
import { Hono } from 'hono';
import { handle } from 'hono/vercel';

// Crear app Hono
const app = new Hono().basePath('/api');

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rutas públicas
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Diabolus CRM</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-black text-white">
  <div class="flex items-center justify-center h-screen">
    <div class="text-center">
      <h1 class="text-4xl font-bold mb-4">⚡ DIABOLUS CRM</h1>
      <p class="text-gray-400 mb-8">Sistema de gestión para pequeños negocios</p>
      <a href="/login" class="px-6 py-3 bg-orange-500 rounded-lg font-semibold hover:bg-orange-600">
        Iniciar sesión
      </a>
    </div>
  </div>
</body>
</html>`);
});

app.get('/login', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Login — Diabolus</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex items-center justify-center min-h-screen">
    <div class="w-full max-w-md">
      <div class="bg-gray-800 border border-gray-700 rounded-lg p-8">
        <div class="flex justify-center mb-8">
          <div class="w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold text-lg">⚡</div>
        </div>
        <h1 class="text-2xl font-bold text-center mb-2">DIABOLUS</h1>
        <p class="text-gray-400 text-center mb-8">Inicia sesión en tu cuenta</p>
        
        <form id="loginForm" class="space-y-4">
          <div>
            <label class="block text-sm font-semibold mb-2">Email</label>
            <input type="email" id="email" required class="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-orange-500" placeholder="tu@email.com" />
          </div>
          <div>
            <label class="block text-sm font-semibold mb-2">Contraseña</label>
            <input type="password" id="password" required class="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-orange-500" placeholder="••••••••" />
          </div>
          <button type="submit" class="w-full px-6 py-2 bg-orange-500 hover:bg-orange-600 rounded-lg font-semibold transition">
            Entrar
          </button>
        </form>

        <p class="text-center text-sm text-gray-400 mt-4">
          ¿No tienes cuenta? <a href="/signup" class="text-orange-400 hover:text-orange-300">Regístrate</a>
        </p>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      localStorage.setItem('token', 'test-token-' + Date.now());
      localStorage.setItem('salon_id', 'salon-' + email.split('@')[0]);
      localStorage.setItem('email', email);
      window.location.href = '/dashboard';
    });
  </script>
</body>
</html>`);
});

app.get('/dashboard', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Dashboard — Diabolus</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex">
    <aside class="w-64 h-screen bg-black border-r border-gray-800 p-6 fixed left-0 top-0">
      <div class="flex items-center gap-3 mb-8">
        <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold">⚡</div>
        <span class="font-bold text-xl">DIABOLUS</span>
      </div>
      <nav class="space-y-2">
        <a href="/dashboard" class="block px-4 py-3 bg-orange-500/20 border-l-2 border-orange-500 text-orange-400 rounded">📊 Dashboard</a>
        <a href="/transactions" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">💰 Transacciones</a>
        <a href="/clients" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">👥 Clientes</a>
        <a href="/reports" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">📈 Reportes</a>
        <a href="/logout" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">🚪 Salir</a>
      </nav>
    </aside>
    
    <main class="ml-64 w-full min-h-screen p-8">
      <h1 class="text-3xl font-bold mb-8">Dashboard</h1>
      <div class="grid grid-cols-4 gap-6">
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Ganancia hoy</p>
          <p class="text-3xl font-bold mt-2">€0.00</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Esta semana</p>
          <p class="text-3xl font-bold mt-2">€0.00</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Este mes</p>
          <p class="text-3xl font-bold mt-2">€0.00</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Balance neto</p>
          <p class="text-3xl font-bold mt-2">€0.00</p>
        </div>
      </div>
    </main>
  </div>

  <script>
    if (!localStorage.getItem('token')) {
      window.location.href = '/login';
    }
  </script>
</body>
</html>`);
});

app.get('/logout', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><title>Logout</title></head>
<body>
  <script>
    localStorage.removeItem('token');
    localStorage.removeItem('salon_id');
    localStorage.removeItem('email');
    window.location.href = '/login';
  </script>
</body>
</html>`);
});

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
