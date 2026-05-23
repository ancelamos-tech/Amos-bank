(() => {
  'use strict';

  // ---------- CONFIG ----------
  const REFRESH_MS = 60_000;

  // ILS is the base — display "1 X = ? ILS" for each of these.
  const BASE = 'ILS';
  const CURRENCIES = [
    { code: 'USD', name: 'US Dollar',          flag: 'US' },
    { code: 'EUR', name: 'Euro',               flag: 'EU' },
    { code: 'GBP', name: 'British Pound',      flag: 'GB' },
    { code: 'JPY', name: 'Japanese Yen',       flag: 'JP' },
    { code: 'CHF', name: 'Swiss Franc',        flag: 'CH' },
    { code: 'CAD', name: 'Canadian Dollar',    flag: 'CA' },
    { code: 'AUD', name: 'Australian Dollar',  flag: 'AU' },
  ];

  const STOCKS = [
    { symbol: 'AAPL',  name: 'Apple Inc.' },
    { symbol: 'MSFT',  name: 'Microsoft' },
    { symbol: 'GOOGL', name: 'Alphabet' },
    { symbol: 'AMZN',  name: 'Amazon' },
    { symbol: 'NVDA',  name: 'NVIDIA' },
    { symbol: 'META',  name: 'Meta Platforms' },
    { symbol: 'TSLA',  name: 'Tesla' },
    { symbol: 'BRK-B', name: 'Berkshire Hathaway' },
    { symbol: 'JPM',   name: 'JPMorgan Chase' },
    { symbol: 'V',     name: 'Visa Inc.' },
  ];

  // ---------- STATE ----------
  const state = {
    fx: {},       // code -> { rate, prev }
    stk: {},      // symbol -> { price, prev, change, changePct, currency }
    wallet: [],
    route: 'currency',
    fxTimer: null,
    stkTimer: null,
    fxOnline: null,
    stkOnline: null,
  };

  // ---------- UTILS ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtMoney = (n, ccy = 'USD', max = 2) => {
    if (n == null || !isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: ccy,
        minimumFractionDigits: 2, maximumFractionDigits: max,
      }).format(n);
    } catch {
      return `${ccy} ${n.toFixed(max)}`;
    }
  };
  const fmtNum = (n, max = 4) => {
    if (n == null || !isFinite(n)) return '—';
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: max,
    }).format(n);
  };
  const fmtTime = (d = new Date()) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  const uid = () => 'h_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const setStatus = (ok, text) => {
    const dot = $('#status-dot'); const t = $('#status-text');
    dot.classList.remove('ok', 'err');
    if (ok === true) dot.classList.add('ok');
    if (ok === false) dot.classList.add('err');
    t.textContent = text;
  };

  // ---------- ROUTING ----------
  function go(route) {
    state.route = route;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.route === route));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${route}`));
    try { history.replaceState(null, '', '#' + route); } catch {}
  }
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => go(b.dataset.route)));

  // ---------- CURRENCY ----------
  function renderFxSkeleton() {
    const grid = $('#fx-grid');
    grid.innerHTML = '';
    for (const c of CURRENCIES) {
      const card = document.createElement('div');
      card.className = 'card skeleton';
      card.dataset.code = c.code;
      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${c.flag}</div>
            <div>
              <div class="card-code">${c.code}</div>
              <div class="card-name">${c.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price"><span class="value">—</span></div>
        <div class="card-foot">
          <span class="change flat">—</span>
          <span class="muted">1 ${c.code} → ILS</span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  async function fetchWithTimeout(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns ratesPerBase[X] = how many X per 1 ILS.
  const FX_SOURCES = [
    {
      name: 'open.er-api.com',
      url: `https://open.er-api.com/v6/latest/${BASE}`,
      parse: (d) => {
        if (!d || !d.rates) throw new Error('payload missing "rates"');
        return { rates: d.rates, ts: d.time_last_update_unix ? new Date(d.time_last_update_unix * 1000) : new Date() };
      },
    },
    {
      name: 'jsdelivr currency-api',
      url: `https://cdn.jsdelivr.net/npm/@fawazahmed/currency-api@latest/v1/currencies/${BASE.toLowerCase()}.json`,
      parse: (d) => {
        const inner = d && d[BASE.toLowerCase()];
        if (!inner) throw new Error('payload missing currency block');
        const rates = {};
        for (const k of Object.keys(inner)) rates[k.toUpperCase()] = inner[k];
        return { rates, ts: d.date ? new Date(d.date) : new Date() };
      },
    },
  ];

  function showFxError(msg, sourceErrors) {
    const banner = $('#fx-error');
    if (!msg) { banner.hidden = true; banner.innerHTML = ''; return; }
    let detail = '';
    if (sourceErrors && sourceErrors.length) {
      detail = '<div style="margin-top:6px;font-size:12px;opacity:0.85;">'
        + sourceErrors.map(e => `<div><code>${e.name}</code>: ${escapeHtml(e.message)}</div>`).join('')
        + '</div>';
    }
    banner.innerHTML = `<div><strong>${escapeHtml(msg)}</strong>${detail}</div>`;
    banner.hidden = false;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function fetchFx() {
    setStatus(null, 'Fetching rates…');
    showFxError(null);
    const errors = [];
    for (const src of FX_SOURCES) {
      try {
        const res = await fetchWithTimeout(src.url, 8000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const { rates, ts } = src.parse(data);
        const ilsPer = {};
        for (const c of CURRENCIES) {
          const r = rates[c.code];
          if (r && isFinite(r) && r > 0) ilsPer[c.code] = 1 / r;
        }
        if (Object.keys(ilsPer).length === 0) throw new Error('no matching currencies in response');
        state.fxOnline = true;
        renderFx(ilsPer, ts, true);
        setStatus(true, `Live · ${fmtTime()}`);
        return;
      } catch (err) {
        const msg = err?.name === 'AbortError' ? 'timeout after 8s' : (err?.message || String(err));
        console.warn('FX source failed:', src.name, msg, err);
        errors.push({ name: src.name, message: msg });
      }
    }
    state.fxOnline = false;
    renderFxError();
    showFxError("Couldn't load exchange rates from any source.", errors);
    setStatus(false, 'Rates offline');
  }

  function renderFx(ilsPer, ts, animate) {
    const grid = $('#fx-grid');
    grid.innerHTML = '';
    for (const c of CURRENCIES) {
      const rate = ilsPer[c.code]; // ILS per 1 unit of c.code
      const prev = state.fx[c.code]?.rate;
      state.fx[c.code] = { rate, prev };

      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.code = c.code;

      let changeHtml = '<span class="change flat">—</span>';
      let flashClass = '';
      if (prev != null && rate != null && prev !== rate) {
        const diff = rate - prev;
        const pct = (diff / prev) * 100;
        const up = diff > 0; // rate up = currency strengthened against ILS
        const cls = up ? 'up' : 'down';
        const arrow = up ? '▲' : '▼';
        changeHtml = `<span class="change ${cls}">${arrow} ${Math.abs(pct).toFixed(3)}%</span>`;
        if (animate) flashClass = up ? 'flash-up' : 'flash-down';
      }

      const display = rate != null ? '₪ ' + fmtNum(rate, 4) : '—';

      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${c.flag}</div>
            <div>
              <div class="card-code">${c.code}</div>
              <div class="card-name">${c.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price">
          <span class="value">${display}</span>
        </div>
        <div class="card-foot">
          ${changeHtml}
          <span class="muted">1 ${c.code} → ILS</span>
        </div>
      `;
      grid.appendChild(card);
      if (flashClass) {
        requestAnimationFrame(() => card.classList.add(flashClass));
        setTimeout(() => card.classList.remove(flashClass), 1100);
      }
    }
    $('#fx-updated').textContent = `Updated ${fmtTime(ts)}`;
  }

  function renderFxError() {
    const grid = $('#fx-grid');
    grid.innerHTML = `
      <div class="empty" style="grid-column: 1/-1;">
        <div class="empty-icon">⚠</div>
        <h3>Couldn't load exchange rates</h3>
        <p>The rates service is unreachable. Check your connection and try again.</p>
      </div>
    `;
    $('#fx-updated').textContent = 'Offline';
  }

  // ---------- STOCKS ----------
  function renderStkSkeleton() {
    const grid = $('#stk-grid');
    grid.innerHTML = '';
    for (const s of STOCKS) {
      const card = document.createElement('div');
      card.className = 'card skeleton';
      card.dataset.symbol = s.symbol;
      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${s.symbol.slice(0, 2)}</div>
            <div>
              <div class="card-code">${s.symbol}</div>
              <div class="card-name">${s.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price"><span class="value">—</span></div>
        <div class="card-foot">
          <span class="change flat">—</span>
          <span class="muted">last trade</span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  async function fetchOneStock(symbol) {
    // Yahoo Finance public chart endpoint — works cross-origin from browsers.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + symbol);
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error('No result for ' + symbol);
    const meta = r.meta || {};
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
    const currency = meta.currency || 'USD';
    if (price == null) throw new Error('No price for ' + symbol);
    return {
      price,
      prevClose,
      currency,
      change: prevClose != null ? price - prevClose : null,
      changePct: prevClose != null ? ((price - prevClose) / prevClose) * 100 : null,
    };
  }

  async function fetchStocks() {
    setStatus(null, 'Fetching quotes…');
    const results = await Promise.allSettled(STOCKS.map(s => fetchOneStock(s.symbol)));
    const updates = {};
    let okCount = 0;
    results.forEach((r, i) => {
      const sym = STOCKS[i].symbol;
      if (r.status === 'fulfilled') {
        updates[sym] = r.value;
        okCount++;
      } else {
        console.warn('Stock failed', sym, r.reason);
      }
    });
    state.stkOnline = okCount > 0;
    renderStocks(updates);
    if (okCount === STOCKS.length)      setStatus(true, `Live · ${fmtTime()}`);
    else if (okCount > 0)                setStatus(true, `Partial · ${okCount}/${STOCKS.length}`);
    else                                  setStatus(false, 'Quotes offline');
  }

  function renderStocks(updates) {
    const grid = $('#stk-grid');
    grid.innerHTML = '';
    let anyOk = false;
    for (const s of STOCKS) {
      const u = updates[s.symbol];
      const prevPrice = state.stk[s.symbol]?.price;
      if (u) {
        state.stk[s.symbol] = { ...u, prev: prevPrice };
        anyOk = true;
      }
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.symbol = s.symbol;

      let priceHtml, changeHtml = '<span class="change flat">—</span>', flashClass = '';
      if (u) {
        priceHtml = `<span class="value">${fmtMoney(u.price, u.currency, 2)}</span>`;
        if (u.change != null) {
          const up = u.change >= 0;
          const cls = u.change === 0 ? 'flat' : (up ? 'up' : 'down');
          const arrow = u.change === 0 ? '' : (up ? '▲' : '▼');
          changeHtml = `<span class="change ${cls}">${arrow} ${u.change >= 0 ? '+' : ''}${fmtNum(u.change, 2)} (${u.changePct >= 0 ? '+' : ''}${fmtNum(u.changePct, 2)}%)</span>`;
        }
        if (prevPrice != null && prevPrice !== u.price) {
          flashClass = u.price > prevPrice ? 'flash-up' : 'flash-down';
        }
      } else {
        priceHtml = `<span class="value muted">unavailable</span>`;
      }

      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${s.symbol.replace('-', '').slice(0, 2)}</div>
            <div>
              <div class="card-code">${s.symbol}</div>
              <div class="card-name">${s.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price">${priceHtml}</div>
        <div class="card-foot">
          ${changeHtml}
          <span class="muted">${u?.currency || 'USD'} · last</span>
        </div>
      `;
      grid.appendChild(card);
      if (flashClass) {
        requestAnimationFrame(() => card.classList.add(flashClass));
        setTimeout(() => card.classList.remove(flashClass), 1100);
      }
    }
    $('#stk-updated').textContent = anyOk ? `Updated ${fmtTime()}` : 'Offline';
  }

  // ---------- WALLET (simplified) ----------
  const WALLET_KEY = 'amosmoney.wallet.v3';

  function loadWallet() {
    try {
      const raw = localStorage.getItem(WALLET_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      state.wallet = Array.isArray(parsed)
        ? parsed.map(e => ({ ...e, kind: e.kind === 'out' ? 'out' : 'in' }))
        : [];
    } catch {
      state.wallet = [];
    }
  }
  function saveWallet() {
    try { localStorage.setItem(WALLET_KEY, JSON.stringify(state.wallet)); } catch {}
  }

  const fmtILS = (n) => '₪ ' + fmtNum(Math.abs(n), 2);

  function renderWallet() {
    const list = $('#wallet-list');
    const empty = $('#wallet-empty');
    list.innerHTML = '';

    const total = state.wallet.reduce((s, h) => {
      const v = Number(h.value) || 0;
      return s + (h.kind === 'out' ? -v : v);
    }, 0);

    const totalEl = $('#wallet-total');
    totalEl.textContent = (total < 0 ? '− ' : '') + fmtILS(total);
    totalEl.classList.toggle('negative', total < 0);

    empty.hidden = state.wallet.length > 0;

    for (const h of state.wallet) {
      const isOut = h.kind === 'out';
      const sign = isOut ? '−' : '+';
      const li = document.createElement('li');
      li.className = isOut ? 'kind-out' : 'kind-in';
      li.innerHTML = `
        <span class="badge" aria-label="${isOut ? 'Spent' : 'Added'}">${sign}</span>
        <span class="name"></span>
        <span class="val">${sign} ${fmtILS(Number(h.value) || 0)}</span>
        <button class="del" aria-label="Delete">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      `;
      li.querySelector('.name').textContent = h.name;
      li.querySelector('.del').addEventListener('click', () => {
        state.wallet = state.wallet.filter(x => x.id !== h.id);
        saveWallet();
        renderWallet();
      });
      list.appendChild(li);
    }
  }

  const walletForm = $('#wallet-form');
  let pendingKind = 'in';
  walletForm.querySelectorAll('button[type="submit"]').forEach(b => {
    b.addEventListener('click', () => { pendingKind = b.dataset.action === 'less' ? 'out' : 'in'; });
  });
  walletForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = walletForm.elements.name.value.trim();
    const value = Number(walletForm.elements.value.value);
    if (!name || !isFinite(value) || value <= 0) return;
    state.wallet.push({ id: uid(), name, value, kind: pendingKind });
    saveWallet();
    renderWallet();
    walletForm.reset();
    pendingKind = 'in';
    walletForm.elements.name.focus();
  });

  // ---------- BOOT ----------
  function startTimers() {
    if (state.fxTimer) clearInterval(state.fxTimer);
    if (state.stkTimer) clearInterval(state.stkTimer);
    state.fxTimer = setInterval(fetchFx, REFRESH_MS);
    state.stkTimer = setInterval(fetchStocks, REFRESH_MS);
  }

  $('#fx-refresh').addEventListener('click', fetchFx);
  $('#stk-refresh').addEventListener('click', fetchStocks);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Refresh quietly when returning to tab if stale > 60s
      fetchFx();
      fetchStocks();
    }
  });

  function boot() {
    const hash = (location.hash || '').replace('#', '');
    if (['currency', 'stocks', 'wallet'].includes(hash)) go(hash);

    renderFxSkeleton();
    renderStkSkeleton();
    loadWallet();
    renderWallet();

    fetchFx();
    fetchStocks();
    startTimers();
  }
  boot();
})();
