const TAILWIND = `<script src="https://cdn.tailwindcss.com"><\/script>`;

const loginPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Diabolus CRM</title>
  ${TAILWIND}
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="relative flex items-center justify-center min-h-screen">
    <div class="w-full max-w-md mx-auto px-4">
      <div class="bg-gray-800/40 backdrop-blur border border-gray-700 rounded-2xl p-8 shadow-2xl">
        <div class="flex justify-center mb-8">
          <div class="w-16 h-16 bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl flex items-center justify-center font-bold text-2xl shadow-lg">⚡<\/div>
        </div>

        <h1 class="text-3xl font-bold text-center mb-2">DIABOLUS<\/h1>
        <p class="text-gray-400 text-center mb-8">CRM para pequeños negocios</p>

        <form id="loginForm" class="space-y-4">
          <div>
            <label class="block text-sm font-semibold mb-2">Email<\/label>
            <input type="email" id="email" required class="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg focus:outline-none focus:border-orange-500" placeholder="tu@email.com" />
          </div>

          <div>
            <label class="block text-sm font-semibold mb-2">Contraseña<\/label>
            <input type="password" id="password" required class="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg focus:outline-none focus:border-orange-500" placeholder="••••••••" />
          </div>

          <button type="submit" class="w-full px-6 py-3 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 rounded-lg font-semibold transition">
            Entrar
          <\/button>
        </form>

        <p class="text-center text-sm text-gray-400 mt-6">
          Demo: cualquier email y contraseña funcionan
        <\/p>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      localStorage.setItem('token', 'jwt-' + Math.random().toString(36).slice(2));
      localStorage.setItem('email', email);
      localStorage.setItem('user', JSON.stringify({
        email,
        name: email.split('@')[0],
        business: 'Mi Negocio'
      }));
      window.location.href = '/dashboard';
    });
  <\/script>
</body>
</html>`;

const dashboardPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Diabolus CRM</title>
  ${TAILWIND}
  <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex h-screen">
    <div class="w-64 bg-black border-r border-gray-800 flex flex-col fixed left-0 top-0 h-screen">
      <div class="p-6 border-b border-gray-800">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold">⚡<\/div>
          <span class="font-bold text-xl">DIABOLUS<\/span>
        </div>
      </div>

      <nav class="flex-1 p-4 space-y-2">
        <a href="/dashboard" class="block px-4 py-3 bg-orange-500/20 border-l-2 border-orange-500 text-orange-400 rounded">📊 Dashboard<\/a>
        <a href="/transacciones" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition">💰 Transacciones<\/a>
        <a href="/clientes" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition">👥 Clientes<\/a>
        <a href="/reportes" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition">📈 Reportes<\/a>
      </nav>

      <div class="p-4 border-t border-gray-800">
        <div class="flex items-center gap-3 px-4 py-3 bg-gray-800 rounded mb-3">
          <div class="w-10 h-10 bg-orange-500 rounded-full flex items-center justify-center font-bold text-sm">👤<\/div>
          <div>
            <p class="text-sm font-semibold" id="userName">Usuario<\/p>
            <p class="text-xs text-gray-400" id="userEmail">email@example.com<\/p>
          </div>
        </div>
        <a href="/logout" class="block w-full px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition text-center text-sm">🚪 Salir<\/a>
      </div>
    </div>

    <main class="ml-64 flex-1 overflow-auto">
      <div class="p-8">
        <div class="mb-8">
          <h1 class="text-4xl font-bold mb-2">Dashboard<\/h1>
          <p class="text-gray-400">Resumen de hoy, <span id="todayDate">12 de junio<\/span><\/p>
        </div>

        <div class="grid grid-cols-4 gap-6 mb-8">
          <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6 hover:border-orange-500/30 transition">
            <p class="text-gray-400 text-sm mb-2">Ganancia hoy<\/p>
            <p class="text-4xl font-bold text-orange-400">€<span id="statToday">0.00<\/span><\/p>
            <p class="text-xs text-gray-500 mt-2">↑ +12%<\/p>
          </div>

          <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6 hover:border-blue-500/30 transition">
            <p class="text-gray-400 text-sm mb-2">Esta semana<\/p>
            <p class="text-4xl font-bold text-blue-400">€<span id="statWeek">0.00<\/span><\/p>
            <p class="text-xs text-gray-500 mt-2">7 días<\/p>
          </div>

          <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6 hover:border-green-500/30 transition">
            <p class="text-gray-400 text-sm mb-2">Este mes<\/p>
            <p class="text-4xl font-bold text-green-400">€<span id="statMonth">0.00<\/span><\/p>
            <p class="text-xs text-gray-500 mt-2">30 días<\/p>
          </div>

          <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6 hover:border-purple-500/30 transition">
            <p class="text-gray-400 text-sm mb-2">Balance neto<\/p>
            <p class="text-4xl font-bold text-purple-400">€<span id="statBalance">0.00<\/span><\/p>
            <p class="text-xs text-gray-500 mt-2">Neto<\/p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-8 mb-8">
          <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
            <h3 class="text-lg font-bold mb-4">Ingresos vs Gastos (7 días)<\/h3>
            <div style="position: relative; height: 250px;">
              <canvas id="chartIncome"><\/canvas>
            </div>
          </div>

          <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
            <h3 class="text-lg font-bold mb-4">Servicios<\/h3>
            <div style="position: relative; height: 250px;">
              <canvas id="chartServices"><\/canvas>
            </div>
          </div>
        </div>

        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
          <h3 class="text-lg font-bold mb-4">Clientes recientes<\/h3>
          <table class="w-full">
            <thead class="border-b border-gray-700">
              <tr>
                <th class="px-6 py-3 text-left text-sm font-semibold">Nombre<\/th>
                <th class="px-6 py-3 text-left text-sm font-semibold">Email<\/th>
                <th class="px-6 py-3 text-left text-sm font-semibold">Último servicio<\/th>
                <th class="px-6 py-3 text-left text-sm font-semibold">Monto<\/th>
              </tr>
            </thead>
            <tbody id="clientsTable" class="divide-y divide-gray-700">
              <tr><td colspan="4" class="px-6 py-4 text-center text-gray-400">Cargando...<\/td><\/tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>

  <script>
    if (!localStorage.getItem('token')) {
      window.location.href = '/login';
    }

    const user = JSON.parse(localStorage.getItem('user') || '{}');
    document.getElementById('userName').textContent = user.name || 'Usuario';
    document.getElementById('userEmail').textContent = user.email || '';

    document.getElementById('todayDate').textContent = new Date().toLocaleDateString('es-ES', {day: 'numeric', month: 'long'});

    function initDashboard() {
      document.getElementById('statToday').textContent = (Math.random() * 500).toFixed(2);
      document.getElementById('statWeek').textContent = (Math.random() * 3500).toFixed(2);
      document.getElementById('statMonth').textContent = (Math.random() * 15000).toFixed(2);
      document.getElementById('statBalance').textContent = (Math.random() * 10000).toFixed(2);

      const ctxIncome = document.getElementById('chartIncome').getContext('2d');
      new Chart(ctxIncome, {
        type: 'bar',
        data: {
          labels: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
          datasets: [
            {label: 'Ingresos', data: [450, 520, 380, 610, 450, 520, 280], backgroundColor: '#10b981'},
            {label: 'Gastos', data: [120, 150, 100, 130, 110, 140, 90], backgroundColor: '#ef4444'}
          ]
        },
        options: {responsive: true, maintainAspectRatio: false, plugins: {legend: {labels: {color: '#9ca3af'}}}, scales: {y: {ticks: {color: '#9ca3af'}, grid: {color: '#374151'}}, x: {ticks: {color: '#9ca3af'}}}}
      });

      const ctxServices = document.getElementById('chartServices').getContext('2d');
      new Chart(ctxServices, {
        type: 'doughnut',
        data: {
          labels: ['Corte', 'Tinte', 'Manicura', 'Pedicura', 'Otros'],
          datasets: [{
            data: [35, 25, 20, 15, 5],
            backgroundColor: ['#f97316', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280'],
            borderColor: '#111827',
            borderWidth: 2
          }]
        },
        options: {responsive: true, maintainAspectRatio: false, plugins: {legend: {position: 'bottom', labels: {color: '#9ca3af'}}}}
      });

      const clients = [
        {name: 'María García', email: 'maria@example.com', service: 'Corte', amount: '€45.00'},
        {name: 'Juan López', email: 'juan@example.com', service: 'Tinte', amount: '€65.00'},
        {name: 'Ana Martínez', email: 'ana@example.com', service: 'Manicura', amount: '€35.00'},
        {name: 'Carlos Rodríguez', email: 'carlos@example.com', service: 'Corte', amount: '€45.00'},
        {name: 'Elena Fernández', email: 'elena@example.com', service: 'Pedicura', amount: '€50.00'}
      ];

      document.getElementById('clientsTable').innerHTML = clients.map(c => \`
        <tr class="hover:bg-gray-700/20 transition">
          <td class="px-6 py-4"><span class="font-semibold">\${c.name}<\/span><\/td>
          <td class="px-6 py-4 text-sm text-gray-400">\${c.email}<\/td>
          <td class="px-6 py-4 text-sm">\${c.service}<\/td>
          <td class="px-6 py-4 font-semibold text-orange-400">\${c.amount}<\/td>
        </tr>
      \`).join('');
    }

    document.addEventListener('DOMContentLoaded', initDashboard);
  <\/script>
</body>
</html>`;

const transaccionesPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transacciones — Diabolus CRM</title>
  ${TAILWIND}
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex h-screen">
    <div class="w-64 bg-black border-r border-gray-800 p-6 fixed left-0 top-0 h-screen">
      <div class="flex items-center gap-3 mb-8">
        <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center">⚡<\/div>
        <span class="font-bold text-xl">DIABOLUS<\/span>
      </div>
      <nav class="space-y-2">
        <a href="/dashboard" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">📊 Dashboard<\/a>
        <a href="/transacciones" class="block px-4 py-3 bg-orange-500/20 border-l-2 border-orange-500 text-orange-400 rounded">💰 Transacciones<\/a>
        <a href="/clientes" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">👥 Clientes<\/a>
        <a href="/reportes" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">📈 Reportes<\/a>
      </nav>
      <div class="border-t border-gray-800 mt-auto pt-4">
        <a href="/logout" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">🚪 Salir<\/a>
      </div>
    </div>

    <main class="ml-64 flex-1 overflow-auto p-8">
      <h1 class="text-4xl font-bold mb-8">Transacciones<\/h1>
      <div class="grid grid-cols-4 gap-6 mb-8">
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Ingresos<\/p><p class="text-3xl font-bold text-green-400 mt-2">€12,450<\/p><\/div>
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Gastos<\/p><p class="text-3xl font-bold text-red-400 mt-2">€2,340<\/p><\/div>
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Balance<\/p><p class="text-3xl font-bold text-blue-400 mt-2">€10,110<\/p><\/div>
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Cantidad<\/p><p class="text-3xl font-bold text-purple-400 mt-2">47<\/p><\/div>
      </div>
      <div class="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-700/50 border-b border-gray-700"><tr><th class="px-6 py-4 text-left">Fecha<\/th><th class="px-6 py-4 text-left">Tipo<\/th><th class="px-6 py-4 text-left">Concepto<\/th><th class="px-6 py-4 text-left">Monto<\/th><th class="px-6 py-4 text-left">Estado<\/th><\/tr><\/thead>
          <tbody class="divide-y divide-gray-700">
            <tr><td class="px-6 py-4">12 Jun<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Ingreso<\/span><\/td><td class="px-6 py-4">Servicio<\/td><td class="px-6 py-4 font-bold text-green-400">+€45.00<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded">Pagado<\/span><\/td><\/tr>
            <tr><td class="px-6 py-4">11 Jun<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Ingreso<\/span><\/td><td class="px-6 py-4">Servicio<\/td><td class="px-6 py-4 font-bold text-green-400">+€65.00<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded">Pagado<\/span><\/td><\/tr>
            <tr><td class="px-6 py-4">10 Jun<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-red-500/20 text-red-300 text-xs rounded">Gasto<\/span><\/td><td class="px-6 py-4">Suministros<\/td><td class="px-6 py-4 font-bold text-red-400">-€120.00<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded">Pagado<\/span><\/td><\/tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>

  <script>if (!localStorage.getItem('token')) window.location.href = '/login';<\/script>
</body>
</html>`;

const clientesPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Clientes — Diabolus CRM</title>
  ${TAILWIND}
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
  <div class="flex h-screen">
    <div class="w-64 bg-black border-r border-gray-800 p-6 fixed left-0 top-0 h-screen">
      <div class="flex items-center gap-3 mb-8">
        <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center">⚡<\/div>
        <span class="font-bold text-xl">DIABOLUS<\/span>
      </div>
      <nav class="space-y-2">
        <a href="/dashboard" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">📊 Dashboard<\/a>
        <a href="/transacciones" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">💰 Transacciones<\/a>
        <a href="/clientes" class="block px-4 py-3 bg-orange-500/20 border-l-2 border-orange-500 text-orange-400 rounded">👥 Clientes<\/a>
        <a href="/reportes" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">📈 Reportes<\/a>
      </nav>
      <div class="border-t border-gray-800 mt-auto pt-4">
        <a href="/logout" class="block px-4 py-3 text-gray-400 hover:bg-gray-800 rounded">🚪 Salir<\/a>
      </div>
    </div>

    <main class="ml-64 flex-1 overflow-auto p-8">
      <h1 class="text-4xl font-bold mb-8">Clientes<\/h1>
      <div class="grid grid-cols-4 gap-6 mb-8">
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Total<\/p><p class="text-3xl font-bold text-blue-400 mt-2">127<\/p><\/div>
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Activos<\/p><p class="text-3xl font-bold text-green-400 mt-2">98<\/p><\/div>
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">Este mes<\/p><p class="text-3xl font-bold text-orange-400 mt-2">15<\/p><\/div>
        <div class="bg-gray-800/50 border border-gray-700 rounded-xl p-6"><p class="text-gray-400 text-sm">VIP<\/p><p class="text-3xl font-bold text-purple-400 mt-2">34<\/p><\/div>
      </div>
      <div class="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-700/50 border-b border-gray-700"><tr><th class="px-6 py-4 text-left">Nombre<\/th><th class="px-6 py-4 text-left">Email<\/th><th class="px-6 py-4 text-left">Teléfono<\/th><th class="px-6 py-4 text-left">Servicios<\/th><th class="px-6 py-4 text-left">Estado<\/th><\/tr><\/thead>
          <tbody class="divide-y divide-gray-700">
            <tr><td class="px-6 py-4 font-semibold">María García<\/td><td class="px-6 py-4 text-sm">maria@example.com<\/td><td class="px-6 py-4 text-sm">+34 612 345 678<\/td><td class="px-6 py-4">5<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Activo<\/span><\/td><\/tr>
            <tr><td class="px-6 py-4 font-semibold">Juan López<\/td><td class="px-6 py-4 text-sm">juan@example.com<\/td><td class="px-6 py-4 text-sm">+34 612 345 679<\/td><td class="px-6 py-4">3<\/td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Activo<\/span><\/td><\/tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>

  <script>if (!localStorage.getItem('token')) window.location.href = '/login';<\/script>
</body>
</html>`;

const logoutPage = `<!DOCTYPE html><html><head><title>Logout<\/title><\/head><body><script>localStorage.clear();window.location.href='/login';<\/script><\/body><\/html>`;

module.exports = async (req, res) => {
  const url = new URL(req.url || '', 'http://localhost');
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (pathname === '/' || pathname === '/login') return res.status(200).send(loginPage);
  if (pathname === '/dashboard') return res.status(200).send(dashboardPage);
  if (pathname === '/transacciones') return res.status(200).send(transaccionesPage);
  if (pathname === '/clientes') return res.status(200).send(clientesPage);
  if (pathname === '/reportes') return res.status(200).send(transaccionesPage);
  if (pathname === '/logout') return res.status(200).send(logoutPage);

  return res.status(404).send('<h1>404 - No encontrado<\/h1>');
};
