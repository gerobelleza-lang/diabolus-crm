module.exports = async (req, res) => {
  const url = new URL(req.url || '', 'http://localhost');
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (pathname === '/login' || pathname === '/') {
    return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Diabolus CRM</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-black text-white">
  <div class="flex items-center justify-center min-h-screen">
    <div class="text-center"><h1 class="text-4xl font-bold mb-4">⚡ DIABOLUS</h1><p class="text-gray-400">Sistema en línea</p></div>
  </div>
</body>
</html>`);
  }

  return res.status(200).send('<h1>OK</h1>');
};
