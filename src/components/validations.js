// Validaciones compartidas

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validatePassword(password) {
  return password && password.length >= 8;
}

function validatePhone(phone) {
  const re = /^[\d\s\-\(\)]{9,}$/;
  return !phone || re.test(phone);
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR'
  }).format(amount);
}

function formatDate(date) {
  return new Intl.DateTimeFormat('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(date));
}

function showError(elementId, message) {
  const elem = document.getElementById(elementId);
  if (elem) {
    elem.textContent = message;
    elem.classList.remove('hidden');
  }
}

function hideError(elementId) {
  const elem = document.getElementById(elementId);
  if (elem) {
    elem.classList.add('hidden');
  }
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
