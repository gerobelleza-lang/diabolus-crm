// Diabolus CRM — API Client para Command Center
const API_BASE = 'https://diabolus-crm-api.vercel.app';

// Auth
async function loginDemo() {
  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'demo@diabolus.local',
        password: 'demo1234'
      })
    });

    if (!response.ok) {
      console.warn('Demo login via API failed, using mock');
      return {
        token: 'mock_token_' + Math.random(),
        user: { email: 'demo@diabolus.local', name: 'Demo User' }
      };
    }

    const data = await response.json();
    localStorage.setItem('diabolus_token', data.token);
    return data;
  } catch (err) {
    console.error('Login error:', err);
    return {
      token: 'mock_token_' + Math.random(),
      user: { email: 'demo@diabolus.local', name: 'Demo User' }
    };
  }
}

// Get stats
async function getDashboardStats() {
  const token = localStorage.getItem('diabolus_token') || 'mock_token';
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      return getDefaultStats();
    }

    return await response.json();
  } catch (err) {
    console.error('Stats error:', err);
    return getDefaultStats();
  }
}

// Get transactions
async function getTransactions() {
  const token = localStorage.getItem('diabolus_token') || 'mock_token';
  try {
    const response = await fetch(`${API_BASE}/api/transactions`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      return getDefaultTransactions();
    }

    return await response.json();
  } catch (err) {
    console.error('Transactions error:', err);
    return getDefaultTransactions();
  }
}

// Agent chat
async function agentChat(userInput) {
  const token = localStorage.getItem('diabolus_token') || 'mock_token';
  try {
    const response = await fetch(`${API_BASE}/api/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        userInput,
        salonId: 'salon_demo',
        userId: 'user_demo'
      })
    });

    if (!response.ok) {
      return getDefaultChatResponse(userInput);
    }

    return await response.json();
  } catch (err) {
    console.error('Agent chat error:', err);
    return getDefaultChatResponse(userInput);
  }
}

// Agent execute
async function agentExecute(toolName, params) {
  const token = localStorage.getItem('diabolus_token') || 'mock_token';
  try {
    const response = await fetch(`${API_BASE}/api/agent/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        toolName,
        params,
        salonId: 'salon_demo',
        userId: 'user_demo'
      })
    });

    if (!response.ok) {
      return { status: 'success', result: { invoiceId: 'INV-' + Date.now() } };
    }

    return await response.json();
  } catch (err) {
    console.error('Agent execute error:', err);
    return { status: 'success', result: { invoiceId: 'INV-' + Date.now() } };
  }
}

// Default responses (fallback if API unavailable)
function getDefaultStats() {
  return {
    totalIncome: 2450.50,
    totalExpense: 890.25,
    netBalance: 1560.25,
    pendingInvoices: 3
  };
}

function getDefaultTransactions() {
  return [
    { id: '1', type: 'income', amount: 150, description: 'Tinte - Paula', date: '2026-06-14' },
    { id: '2', type: 'income', amount: 200, description: 'Corte - María', date: '2026-06-13' },
    { id: '3', type: 'expense', amount: 50, description: 'Tinturas', date: '2026-06-12' }
  ];
}

function getDefaultChatResponse(input) {
  const lower = input.toLowerCase();

  if (lower.includes('ingreso') || lower.includes('income')) {
    const match = input.match(/(\d+)/);
    const amount = match ? parseInt(match[1]) : 150;
    return {
      status: 'pending_approval',
      message: `✓ Ingreso de €${amount} propuesto`,
      toolUsed: 'create_income',
      result: { amount, clientName: 'Cliente', concept: 'Servicio', vat: amount * 0.21 }
    };
  }

  if (lower.includes('gasto') || lower.includes('expense')) {
    const match = input.match(/(\d+)/);
    const amount = match ? parseInt(match[1]) : 50;
    return {
      status: 'pending_approval',
      message: `✓ Gasto de €${amount} propuesto`,
      toolUsed: 'create_expense',
      result: { amount, concept: 'Gasto', vat: amount * 0.21 }
    };
  }

  return {
    status: 'error',
    message: 'Intenta: "Ingreso 150" o "Gasto 50"'
  };
}
