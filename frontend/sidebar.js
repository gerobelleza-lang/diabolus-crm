// sidebar.js — Diabolus CRM Accordion Sidebar v2.1
// Reemplaza automáticamente cualquier <aside class="sidebar"> con el menú acordeón.
(function () {
  'use strict';

  // ── Secciones y páginas ───────────────────────────────────────────────────
  var SECTIONS = [
    {
      key: 'mando', label: '🎯 Mando',
      items: [
        { key: 'dashboard', icon: '📊', label: 'Dashboard', href: 'dashboard.html' }
      ]
    },
    {
      key: 'negocio', label: '💼 Negocio',
      items: [
        { key: 'invoices',     icon: '📄', label: 'Facturas',      href: 'invoices.html' },
        { key: 'clients',      icon: '👥', label: 'Clientes',       href: 'clients.html' },
        { key: 'transactions', icon: '💰', label: 'Transacciones',  href: 'transactions.html' },
        { key: 'reports',      icon: '📈', label: 'Reportes',       href: 'reports.html' },
        { key: 'catalogo',    icon: '📦', label: 'Catálogo',       href: 'catalogo.html' },
        { key: 'importar',    icon: '📥', label: 'Importar',       href: 'importar.html' },
      ]
    },
    {
      key: 'inteligencia', label: '🧠 Inteligencia',
      items: [
        { key: 'chat',      icon: '💬', label: 'Diablilla',   href: 'chat.html' },
        { key: 'equipo',    icon: '🔥', label: 'Mi Equipo',   href: 'equipo.html' },
        { key: 'documents', icon: '📋', label: 'Documentos',  href: 'documents.html' }
      ]
    },
    {
      key: 'modulos', label: '⚡ Módulos',
      items: [
        { key: 'cazador', icon: '🗡️', label: 'El Cazador', href: 'cazador.html', badge: 'AUTO' },
        { key: 'pacto',   icon: '🔥', label: 'El Pacto',   href: 'pacto.html',  badge: 'LEADS' },
        { key: 'demonio', icon: '😈', label: 'El Demonio', href: 'demonio.html',badge: 'WA' }
      ]
    }
  ];

  var LS_KEY = 'diabolus_sidebar_v2';
  var page = (window.location.pathname.split('/').pop() || 'dashboard').replace('.html', '') || 'dashboard';

  function loadState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
  }
  function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function buildDefault() {
    var s = {};
    var mobile = window.innerWidth < 768;
    SECTIONS.forEach(function (sec) {
      s[sec.key] = !mobile;
    });
    return s;
  }
  function getState() {
    return loadState() || buildDefault();
  }

  function injectCSS() {
    if (document.getElementById('dsb-css')) return;
    var s = document.createElement('style');
    s.id = 'dsb-css';
    s.textContent = [
      '.dsb-hdr{padding:0 1.25rem 1.1rem;text-align:center;border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:.35rem}',
      '.dsb-salon{font-size:.7rem;color:rgba(255,255,255,.38);margin-top:.3rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsb-nav{flex:1;padding:.2rem .5rem}',
      '.dsb-sec{margin-bottom:.05rem}',
      '.dsb-sec-hdr{display:flex;align-items:center;justify-content:space-between;padding:.32rem .7rem;cursor:pointer;border-radius:.35rem;user-select:none;transition:background .15s}',
      '.dsb-sec-hdr:hover{background:rgba(255,255,255,.04)}',
      '.dsb-sec-lbl{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.32)}',
      '.dsb-sec-arr{font-size:.52rem;color:rgba(255,255,255,.22);transition:transform .22s ease;display:inline-block}',
      '.dsb-sec-arr.dsb-open{transform:rotate(90deg)}',
      '.dsb-sec-items{overflow:hidden;transition:max-height .28s ease,opacity .22s;max-height:0;opacity:0}',
      '.dsb-sec-items.dsb-open{max-height:500px;opacity:1}',
      '.dsb-item{padding:.52rem .85rem;margin-bottom:.08rem;border-radius:.42rem;display:flex;align-items:center;gap:.6rem;color:rgba(255,255,255,.48);text-decoration:none;font-weight:500;font-size:.82rem;transition:all .15s;position:relative}',
      '.dsb-item:hover{background:rgba(139,92,246,.1);color:rgba(255,255,255,.82)}',
      '.dsb-item.dsb-active{background:rgba(139,92,246,.18);color:#a78bfa;font-weight:600}',
      '.dsb-item.dsb-active::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:2px;background:#8B5CF6;border-radius:2px}',
      '.dsb-ico{font-size:.88rem;width:1.05rem;text-align:center;flex-shrink:0}',
      '.dsb-badge{margin-left:auto;font-size:.54rem;font-weight:700;padding:.08rem .32rem;border-radius:20px;background:rgba(139,92,246,.18);color:#a78bfa;letter-spacing:.04em;border:1px solid rgba(139,92,246,.22);white-space:nowrap}',
      '.dsb-foot{padding:.8rem .7rem;border-top:1px solid rgba(255,255,255,.07);margin-top:auto}',
      '.dsb-ver{text-align:center;font-size:.58rem;color:rgba(255,255,255,.18);margin-top:.35rem;font-family:monospace}',
      /* ── MOBILE RESPONSIVE ── */
      '@media(max-width:768px){',
      'aside.sidebar,nav.sidebar,#db-sidebar{position:fixed!important;left:-280px!important;top:0!important;width:260px!important;height:100vh!important;z-index:9999!important;transition:left .3s ease!important;overflow-y:auto!important;background:#12121a!important;box-shadow:none!important;display:flex!important;flex-direction:column!important}',
      'aside.sidebar.dsb-open,nav.sidebar.dsb-open,#db-sidebar.dsb-open{left:0!important;box-shadow:4px 0 20px rgba(0,0,0,.5)!important}',
      '}',
      '.dsb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;opacity:0;pointer-events:none;transition:opacity .3s}',
      '.dsb-overlay.dsb-open{opacity:1;pointer-events:auto}',
      '.dsb-hamburger{display:none;background:none;border:1px solid rgba(255,255,255,.15);color:#fff;font-size:1.4rem;padding:.3rem .6rem;border-radius:6px;cursor:pointer;z-index:100;position:fixed;top:12px;left:12px;z-index:9000}',
      '@media(max-width:768px){.dsb-hamburger{display:block}}',
      /* ── GLOBAL MOBILE FIX: main-content visible ── */
      '@media(max-width:768px){',
      '.main-content,main.main-content,[class*="main-content"]{margin-left:0!important;padding:1rem!important;max-width:100vw!important;width:100%!important;overflow-x:hidden!important}',
      '.page-header{flex-direction:column!important;gap:.75rem!important;padding-bottom:1rem!important}',
      '.page-header h1{font-size:1.3rem!important;padding-left:2.5rem!important}',
      'table{display:block!important;overflow-x:auto!important;-webkit-overflow-scrolling:touch!important;white-space:nowrap!important;font-size:.8rem!important}',
      'thead,tbody,tr{display:table!important;width:100%!important;table-layout:auto!important}',
      'th,td{padding:.5rem .6rem!important;font-size:.78rem!important}',
      '.filters-bar{flex-direction:column!important;gap:.5rem!important;padding:.75rem!important}',
      '.filter-group{min-width:unset!important;width:100%!important}',
      '.hero-row{grid-template-columns:1fr!important}',
      '.hero-card{grid-column:span 1!important}',
      '.charts-row{grid-template-columns:1fr!important}',
      '.bottom-grid{grid-template-columns:1fr!important}',
      '.stats-grid{grid-template-columns:1fr 1fr!important}',
      '}',
      '.dsb-mob-banner{display:none;padding:.6rem 1rem;text-decoration:none;font-size:.85rem;font-weight:600;border-radius:8px;text-align:center;margin:4px 8px}',
      '@media(max-width:768px){.dsb-mob-banner{display:block}}',
      '.dsb-mob-dash{background:rgba(139,92,246,.12);color:#a78bfa;border:1px solid rgba(139,92,246,.25)}',
      '.dsb-mob-agent{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.2)}'

    ].join('');
    document.head.appendChild(s);
  }

  var LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 220" style="width:100%;max-width:186px;display:block;margin:0 auto" aria-label="Diabolus"><defs><filter id="dsb-fs" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="12" result="b1"/><feGaussianBlur stdDeviation="5" result="b2"/><feGaussianBlur stdDeviation="2" result="b3"/><feMerge><feMergeNode in="b1"/><feMergeNode in="b2"/><feMergeNode in="b3"/><feMergeNode in="SourceGraphic"/></feMerge></filter><filter id="dsb-fg" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><filter id="dsb-sd" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity=".85"/></filter><linearGradient id="dsb-gv" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#E0D0FF"/><stop offset="40%" stop-color="#C4B5FD"/><stop offset="100%" stop-color="#7C3AED"/></linearGradient></defs><text x="350" y="160" font-family="Georgia,\'Times New Roman\',serif" font-size="140" font-weight="900" font-style="italic" text-anchor="middle" fill="none" stroke="#1a0033" stroke-width="18" filter="url(#dsb-sd)" transform="skewX(-18)">Diabolus</text><text x="350" y="160" font-family="Georgia,\'Times New Roman\',serif" font-size="140" font-weight="900" font-style="italic" text-anchor="middle" fill="none" stroke="#8B5CF6" stroke-width="3" filter="url(#dsb-fs)" transform="skewX(-18)" opacity=".9">Diabolus</text><text x="350" y="160" font-family="Georgia,\'Times New Roman\',serif" font-size="140" font-weight="900" font-style="italic" text-anchor="middle" fill="url(#dsb-gv)" stroke="#C4B5FD" stroke-width=".4" transform="skewX(-18)">Diabolus</text><line x1="30" y1="178" x2="620" y2="168" stroke="#E3BE7A" stroke-width="1.2" stroke-linecap="round" filter="url(#dsb-fg)" opacity=".85"/></svg>';

  function render() {
    var sidebar = document.querySelector('aside.sidebar') || document.querySelector('nav.sidebar') || document.querySelector('aside[id*="sidebar"]') || document.querySelector('#db-sidebar');
    if (!sidebar) return;

    var state   = getState();
    var salon   = '';
    try {
      var a = JSON.parse(localStorage.getItem('diabolus_auth'));
      salon = (a && (a.salonName || a.salonname)) || '';
    } catch (e) {}

    var sectionsHTML = SECTIONS.map(function (sec) {
      var open = !!state[sec.key];
      var items = sec.items.map(function (item) {
        var active = (item.key === page);
        var badge  = item.badge ? '<span class="dsb-badge">' + item.badge + '</span>' : '';
        return '<a href="' + item.href + '" class="dsb-item' + (active ? ' dsb-active' : '') + '">' +
          '<span class="dsb-ico">' + item.icon + '</span>' + item.label + badge + '</a>';
      }).join('');
      return '<div class="dsb-sec" data-dsb="' + sec.key + '">' +
        '<div class="dsb-sec-hdr" onclick="window.__dsbTog(\'' + sec.key + '\')">' +
        '<span class="dsb-sec-lbl">' + sec.label + '</span>' +
        '<span class="dsb-sec-arr' + (open ? ' dsb-open' : '') + '">&#9658;</span>' +
        '</div>' +
        '<div class="dsb-sec-items' + (open ? ' dsb-open' : '') + '">' + items + '</div>' +
        '</div>';
    }).join('');

    sidebar.innerHTML =
      '<div class="dsb-hdr">' + LOGO +
      '<div class="dsb-salon" id="dsb-salon">' + (salon || 'Diabolus CRM') + '</div></div>' +
      '<nav class="dsb-nav">' + sectionsHTML + '</nav>' +
      '<div class="dsb-foot">' +
      '<button class="btn btn-secondary" style="width:100%;font-size:.8rem;padding:.58rem" ' +
      'onclick="if(typeof logout===\'function\'){logout()}else{localStorage.removeItem(\'diabolus_auth\');window.location.href=\'index-login.html\'}">Cerrar sesión</button>' +
      '<div class="dsb-ver">Diabolus CRM v2.1</div>' +
      '</div>';

    // ── MOBILE: inject overlay, hamburger, and banners ──
    if (window.innerWidth < 768 || true) { // always inject, CSS controls visibility
      // Overlay
      if (!document.getElementById('dsb-overlay')) {
        var ov = document.createElement('div');
        ov.id = 'dsb-overlay';
        ov.className = 'dsb-overlay';
        ov.onclick = function() { window.__dsbCloseSidebar(); };
        document.body.appendChild(ov);
      }

      // Hamburger — fixed position button
      if (!document.getElementById('dsb-hamburger')) {
        var hb = document.createElement('button');
        hb.id = 'dsb-hamburger';
        hb.className = 'dsb-hamburger';
        hb.setAttribute('aria-label', 'Menú');
        hb.textContent = '☰';
        hb.onclick = function(e) { e.stopPropagation(); window.__dsbToggleSidebar(); };
        document.body.appendChild(hb);
      }

      // Mobile banners — insert before main content sections
      var mainContent = document.querySelector('.main-content') || document.querySelector('.main') || document.querySelector('main') || document.querySelector('.db-main') || document.querySelector('.container');
      if (mainContent && !document.getElementById('dsb-mob-banners')) {
        var bannersDiv = document.createElement('div');
        bannersDiv.id = 'dsb-mob-banners';
        var isDashboard = (page === 'dashboard');
        var isChat = (page === 'chat');
        bannersDiv.innerHTML =
          (isDashboard ? '' : '<a href="dashboard.html" class="dsb-mob-banner dsb-mob-dash">📊 ← Dashboard</a>') +
          '<a href="mobile.html" class="dsb-mob-banner dsb-mob-agent">💬 Diablilla · Agente IA</a>';
        // Insert after the page header or at the top
        var ph = mainContent.querySelector('.page-header');
        if (ph && ph.nextSibling) {
          mainContent.insertBefore(bannersDiv, ph.nextSibling);
        } else {
          mainContent.insertBefore(bannersDiv, mainContent.firstChild);
        }
      }
    }

    var authEl = document.getElementById('salonName') || document.getElementById('salonNameSidebar');
    if (authEl) {
      var observer = new MutationObserver(function () {
        var el = document.getElementById('dsb-salon');
        if (el && authEl.textContent && authEl.textContent !== '—' && authEl.textContent !== 'Cargando...') {
          el.textContent = authEl.textContent;
        }
      });
      observer.observe(authEl, { childList: true, characterData: true, subtree: true });
    }
  }

  window.__dsbTog = function (key) {
    var state = getState();
    state[key] = !state[key];
    saveState(state);
    var sec = document.querySelector('.dsb-sec[data-dsb="' + key + '"]');
    if (!sec) return;
    var arr   = sec.querySelector('.dsb-sec-arr');
    var items = sec.querySelector('.dsb-sec-items');
    if (arr)   arr.classList.toggle('dsb-open',   !!state[key]);
    if (items) items.classList.toggle('dsb-open', !!state[key]);
  };

  // ── MOBILE: sidebar toggle ──
  window.__dsbToggleSidebar = function() {
    var sidebar = document.querySelector('aside.sidebar') || document.querySelector('nav.sidebar') || document.querySelector('aside[id*="sidebar"]') || document.querySelector('#db-sidebar');
    var overlay = document.getElementById('dsb-overlay');
    if (sidebar) sidebar.classList.toggle('dsb-open');
    if (overlay) overlay.classList.toggle('dsb-open');
  };
  window.__dsbCloseSidebar = function() {
    var sidebar = document.querySelector('aside.sidebar') || document.querySelector('nav.sidebar') || document.querySelector('aside[id*="sidebar"]') || document.querySelector('#db-sidebar');
    var overlay = document.getElementById('dsb-overlay');
    if (sidebar) sidebar.classList.remove('dsb-open');
    if (overlay) overlay.classList.remove('dsb-open');
  };

  // Close sidebar when clicking outside on mobile
  document.addEventListener('click', function (e) {
    if (window.innerWidth < 768) {
      var sb = document.querySelector('aside.sidebar') || document.querySelector('nav.sidebar') || document.querySelector('aside[id*="sidebar"]') || document.querySelector('#db-sidebar');
      if (sb && sb.classList.contains('dsb-open') && !sb.contains(e.target) && !e.target.classList.contains('dsb-hamburger')) {
        window.__dsbCloseSidebar();
      }
    }
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('a[href]');
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript')) return;
    if (href.startsWith('http://') || href.startsWith('https://')) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = href;
  }, true);

  injectCSS();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
