export default async function handler(req: any, res: any) {
  const { pathname } = new URL(req.url || '', 'http://localhost');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (pathname === '/login' || pathname === '/') {
    return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Login — Diabolus</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex items-center justify-center min-h-screen">
    <div class="w-full max-w-md">
      <div class="bg-gray-800 border border-gray-700 rounded-lg p-8">
        <div class="flex justify-center mb-8">
          <div class="w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold text-lg">⚡<\/div>
        </div>
        <h1 class="text-2xl font-bold text-center mb-2">DIABOLUS CRM</h1>
        <p class="text-gray-400 text-center mb-8">Inicia sesión en tu cuenta</p>
        
        <form onsubmit="handleLogin(event)" class="space-y-4">
          <div>
            <label class="block text-sm font-semibold mb-2">Email<\/label>
            <input type="email" id="email" required class="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-orange-500" placeholder="tu@email.com" />
          </div>
          <div>
            <label class="block text-sm font-semibold mb-2">Contraseña<\/label>
            <input type="password" id="password" required class="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-orange-500" placeholder="••••••••" />
          </div>
          <button type="submit" class="w-full px-6 py-2 bg-orange-500 hover:bg-orange-600 rounded-lg font-semibold transition">Entrar<\/button>
        </form>
      </div>
    </div>
  </div>

  <script>
    function handleLogin(e) {
      e.preventDefault();
      const email = document.getElementById('email').value;
      localStorage.setItem('token', 'test-token-' + Date.now());
      localStorage.setItem('salon_id', 'salon-' + email.split('@')[0]);
      localStorage.setItem('email', email);
      window.location.href = '/dashboard';
    }
  <\/script>
</body>
</html>`);
  }

  if (pathname === '/dashboard') {
    return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Dashboard — Diabolus</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex">
    <aside class="w-64 h-screen bg-black border-r border-gray-800 p-6 fixed left-0 top-0 overflow-y-auto">
      <div class="flex items-center gap-3 mb-8">
        <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold">⚡<\/div>
        <span class="font-bold text-xl">DIABOLUS<\/span>
      </div>
      <nav class="space-y-2 mb-8">
        <a href="/dashboard" class="block px-4 py-3 bg-orange-500/20 border-l-2 border-orange-500 text-orange-400 rounded">📊 Dashboard<\/a>
        <a href="/transactions" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">💰 Transacciones<\/a>
        <a href="/clients" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">👥 Clientes<\/a>
        <a href="/reports" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">📈 Reportes<\/a>
      </nav>
      <div class="border-t border-gray-800 pt-4">
        <a href="/logout" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">🚪 Salir<\/a>
      </div>
    </aside>
    
    <main class="ml-64 w-full min-h-screen p-8">
      <h1 class="text-3xl font-bold mb-8">Dashboard<\/h1>
      <div class="grid grid-cols-4 gap-6 mb-8">
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Ganancia hoy<\/p>
          <p class="text-3xl font-bold mt-2 text-orange-400">€0.00<\/p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Esta semana<\/p>
          <p class="text-3xl font-bold mt-2 text-blue-400">€0.00<\/p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Este mes<\/p>
          <p class="text-3xl font-bold mt-2 text-green-400">€0.00<\/p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <p class="text-gray-400 text-sm">Balance neto<\/p>
          <p class="text-3xl font-bold mt-2 text-purple-400">€0.00<\/p>
        </div>
      </div>
      <p class="text-gray-400">Contenido del dashboard en construcción...<\/p>
    </main>
  </div>

  <script>
    if (!localStorage.getItem('token')) {
      window.location.href = '/login';
    }
  <\/script>
</body>
</html>`);
  }

  if (pathname === '/logout') {
    return res.status(200).send(`<!DOCTYPE html>
<html>
<head><title>Logout<\/title><\/head>
<body>
  <script>
    localStorage.clear();
    window.location.href = '/login';
  <\/script>
<\/body>
<\/html>`);
  }

  return res.status(404).send('404 - Not Found');
}
