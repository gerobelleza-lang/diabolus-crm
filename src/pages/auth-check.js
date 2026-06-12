// auth-check.js — Middleware de verificación de autenticación
// Incluir este script en las páginas que requieren auth

function checkAuth() {
  const token = localStorage.getItem('token');
  const salonId = localStorage.getItem('salon_id');

  if (!token || !salonId) {
    // Redirigir a login si no hay token
    window.location.href = '/login';
    return false;
  }

  return { token, salonId };
}

// Exportar para uso en otras páginas
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkAuth };
}
